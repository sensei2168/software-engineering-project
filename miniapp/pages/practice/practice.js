/**
 * 答题页：出题 → 作答 → 收卷批改。
 *
 * 流程：
 * 1. onLoad 校验 URL 上的练习设置（沿用设置页 practice-config 的契约）；
 *    URL 不合法时只显示“练习设置无效”，不生成题目（对应验收 T30）。
 * 2. 调 question-service 出题（云端优先，云环境没配好时自动本地兜底）。
 * 3. 13 个设置预设全部可出题；遇到未知题型时显示“该题型尚未开放”作为兜底，
 *    不会静默降级成别的题型。
 * 4. 逐题作答，答案存在 answers 数组里，空字符串表示未答。
 * 5. 提交时把「题目 + 作答」交给同一套判分逻辑，拿到 result。
 * 6. 交卷后留在本页进入只读回顾：题号方块按对/错/未答分色，点击回看你的答案与正确答案；
 *    结果仍通过 eventChannel + pendingPracticeResult 交给结果页。
 * 7. 底部「题目导航」在作答和回顾阶段都能点击跳转。
 *
 * 限时模式：第一题出现时开始计时，时间到自动收卷；提交后立即停表。
 * submitting / submitted 标记保证「手动提交」和「到时自动提交」只会产生一份结果。
 */
const { fromQuery, toQuery, getConfigDisplay } = require('../../utils/practice-config');
const questionService = require('../../services/question-service');

const TIMER_INTERVAL_MS = 250;

function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function buildAnswersView(answers) {
  const view = [];
  for (let i = 0; i < answers.length; i += 1) view.push(answers[i] === undefined ? '' : answers[i]);
  return view;
}

/** 部分环境（例如 Node 里的单元测试）没有定时器，做一个安全包装。 */
function later(fn, ms) {
  if (typeof setTimeout === 'function') setTimeout(fn, ms);
}

/** 从 "1/4 + 1/4 = 2/4" 里取出 "2/4"，用于回顾时只显示答案。 */
function answerPartOf(correctText) {
  const text = String(correctText || '');
  const index = text.lastIndexOf('= ');
  return index === -1 ? text : text.slice(index + 2);
}

Page({
  data: {
    loading: true,
    config: null,
    display: null,
    error: '',
    loadError: '',
    unavailable: null,
    quizId: '',
    questions: [],
    answers: [],
    currentIndex: 0,
    currentText: '',
    currentValue: '',
    answeredCount: 0,
    total: 0,
    answerKind: 'integer',
    fractionMode: false,
    fractionNumerator: '',
    fractionDenominator: '',
    inputType: 'number',
    inputMaxLength: 4,
    inputFocus: false,
    submitting: false,
    finished: false,
    navCells: [],
    reviewMode: false,
    summary: null,
    reviewUserText: '',
    reviewCorrectAnswer: '',
    reviewVerdict: '',
    mode: 'normal',
    timed: false,
    remainingText: '',
    remainingSeconds: 0
  },

  onLoad(options) {
    this.questions = [];
    this.answers = [];
    this.config = null;
    this.startTime = 0;
    this.submitted = false;
    this.tickTimer = null;
    this.pageActive = true;
    this.result = null;

    const parsed = fromQuery(options);
    if (!parsed.ok) {
      // 验收 T30：非法链接只提示设置无效，不展示任何有效练习配置
      this.setData({ loading: false, error: '练习设置无效，请返回设置页面重新选择。' });
      return;
    }
    this.config = parsed.value;
    this.setData({
      config: parsed.value,
      display: getConfigDisplay(parsed.value),
      mode: parsed.value.mode,
      timed: parsed.value.mode === 'timed',
      remainingText: parsed.value.mode === 'timed' ? formatClock(parsed.value.durationSeconds) : ''
    });
    this.loadQuiz();
  },

  onShow() {
    this.pageActive = true;
    if (this.questions && this.questions.length && !this.submitted) {
      if (!this.startTime) this.beginQuiz();
      else this.startTimerLoop();
    }
  },

  onHide() {
    // 页面不可见时停止刷新倒计时；计时以 Date.now() 为准，回来后按真实时间差继续
    this.pageActive = false;
    this.clearTimer();
  },

  onUnload() {
    this.pageActive = false;
    this.clearTimer();
  },

  /** 出题：云端优先，失败自动本地兜底（question-service 内部处理）。 */
  async loadQuiz() {
    try {
      const response = await questionService.createQuestionSet(this.config);
      if (!this.pageActive) return;
      if (!response.ok) {
        if (response.code === 'UNSUPPORTED_RULE') {
          this.setData({
            loading: false,
            unavailable: {
              title: '该题型尚未开放',
              message: response.message
            }
          });
          return;
        }
        this.setData({ loading: false, loadError: response.message || '出题失败，请重试。' });
        return;
      }
      const data = response.data;
      const answers = data.questions.map(function () { return ''; });
      this.questions = data.questions;
      this.answers = answers;
      this.setData({
        loading: false,
        loadError: '',
        unavailable: null,
        quizId: data.quizId,
        questions: data.questions,
        answers: answers,
        total: data.questions.length,
        answeredCount: 0,
        finished: false,
        submitting: false,
        navCells: data.questions.map(function (question, index) {
          return { no: index + 1, state: 'unanswered' };
        }),
        reviewMode: false,
        summary: null,
        reviewUserText: '',
        reviewCorrectAnswer: '',
        reviewVerdict: ''
      });
      this.result = null;
      this.applyQuestion(0);
      this.beginQuiz();
      console.log('[practice] 出题来源：' + response.source + '，ruleId：' + data.questions[0].ruleId + '，共 ' + data.questions.length + ' 题');
    } catch (error) {
      console.error('[practice] 出题异常', error);
      if (this.pageActive) this.setData({ loading: false, loadError: '出题失败，请检查网络后重试。' });
    }
  },

  /** 正式开始：记录开始时间，限时模式启动定时器（只在题目加载完成后调用一次）。 */
  beginQuiz() {
    this.startTime = Date.now();
    this.startTimerLoop();
  },

  /** 启动倒计时刷新；不清空 startTime，切后台回来时沿用原来的开始时间。 */
  startTimerLoop() {
    this.clearTimer();
    if (!this.data.timed) return;
    if (typeof setInterval !== 'function') return;
    this.tickTimer = setInterval(() => this.tick(), TIMER_INTERVAL_MS);
    this.tick();
  },

  clearTimer() {
    if (this.tickTimer) {
      if (typeof clearInterval === 'function') clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  },

  tick() {
    if (!this.data.timed || this.submitted) return;
    const duration = this.config.durationSeconds;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const remaining = Math.max(0, duration - elapsed);
    const text = formatClock(remaining);
    if (text !== this.data.remainingText) {
      this.setData({ remainingText: text, remainingSeconds: Math.ceil(remaining) });
    }
    if (remaining <= 0 && !this.submitted) {
      // 到时直接收卷，不弹“还有 N 题没填”的确认框
      this.submit('timeup');
    }
  },

  /** 数字键盘输入：整数最多 4 位；小数允许一个小数点。 */
  onAnswerInput(event) {
    if (this.data.finished) return;
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.answers.length) return;
    const raw = event.detail.value === undefined || event.detail.value === null ? '' : String(event.detail.value);
    let cleaned;
    if (this.data.answerKind === 'decimal') {
      cleaned = raw.replace(/[^0-9.]/g, '');
      const dot = cleaned.indexOf('.');
      if (dot !== -1) {
        cleaned = cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
      }
      cleaned = cleaned.slice(0, 4);
    } else {
      cleaned = raw.replace(/[^0-9]/g, '').slice(0, 4);
    }
    this.answers[index] = cleaned;
    const patch = { currentValue: cleaned, answers: this.answers, answeredCount: this.countAnswered() };
    patch['navCells[' + index + '].state'] = cleaned === '' ? 'unanswered' : 'answered';
    this.setData(patch);
  },

  /** 分数题：分子、分母两个输入框，拼成 "n/d" 存进 answers。 */
  onFractionInput(event) {
    if (this.data.finished) return;
    const index = this.data.currentIndex;
    if (!Number.isInteger(index) || index < 0 || index >= this.answers.length) return;
    const part = event.currentTarget.dataset.part;
    const raw = event.detail.value === undefined || event.detail.value === null ? '' : String(event.detail.value);
    const cleaned = raw.replace(/[^0-9]/g, '').slice(0, 2);
    const numerator = part === 'numerator' ? cleaned : this.data.fractionNumerator;
    const denominator = part === 'denominator' ? cleaned : this.data.fractionDenominator;
    let composed = '';
    if (numerator !== '' || denominator !== '') composed = numerator + '/' + denominator;
    this.answers[index] = composed;
    const patch = { answers: this.answers, answeredCount: this.countAnswered() };
    patch['navCells[' + index + '].state'] = composed === '' ? 'unanswered' : 'answered';
    if (part === 'numerator') patch.fractionNumerator = cleaned;
    else patch.fractionDenominator = cleaned;
    this.setData(patch);
  },

  countAnswered() {
    let count = 0;
    for (let i = 0; i < this.answers.length; i += 1) {
      if (this.answers[i] !== '') count += 1;
    }
    return count;
  },

  /** 载入第 index 题：按题型切换输入方式（整数/小数/分数），并恢复已填答案。 */
  applyQuestion(index) {
    const question = this.questions[index];
    if (!question) return;
    const kind = question.answerKind || 'integer';
    const stored = this.answers[index] || '';
    const review = this.result && this.result.questions ? this.result.questions[index] : null;
    let numerator = '';
    let denominator = '';
    if (kind === 'fraction' && stored.indexOf('/') !== -1) {
      const parts = stored.split('/');
      numerator = parts[0] || '';
      denominator = parts[1] || '';
    }
    this.setData({
      currentIndex: index,
      currentText: question.text,
      answerKind: kind,
      fractionMode: kind === 'fraction',
      inputType: kind === 'decimal' ? 'digit' : 'number',
      inputMaxLength: kind === 'fraction' ? 2 : 4,
      fractionNumerator: numerator,
      fractionDenominator: denominator,
      currentValue: kind === 'fraction' ? '' : stored,
      reviewMode: Boolean(review),
      reviewUserText: review ? (review.verdict === 'blank' ? '未答' : (review.userText || '—')) : '',
      reviewCorrectAnswer: review ? answerPartOf(review.correctText) : '',
      reviewVerdict: review ? review.verdict : '',
      inputFocus: false
    });
    if (!review) {
      later(() => {
        this.setData({ inputFocus: true });
      }, 80);
    }
  },

  /** 切到第 index 题：先失焦再聚焦，避免输入框残留上一题的值。 */
  goTo(index) {
    if (!this.questions.length) return;
    const target = Math.min(this.questions.length - 1, Math.max(0, index));
    this.applyQuestion(target);
  },

  /** 点题号方块跳转；作答和回顾状态都可用。 */
  jumpTo(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= this.questions.length) return;
    this.goTo(index);
  },

  prevQuestion() {
    if (this.data.currentIndex > 0) this.goTo(this.data.currentIndex - 1);
  },

  nextQuestion() {
    const next = this.data.currentIndex + 1;
    if (next < this.questions.length) this.goTo(next);
  },

  onSubmitTap() {
    if (this.submitted || this.data.submitting) return;
    const answered = this.countAnswered();
    const blankCount = this.questions.length - answered;
    if (answered === 0) {
      wx.showToast({ title: '还没有填写答案', icon: 'none' });
      return;
    }
    if (blankCount > 0) {
      wx.showModal({
        title: '还有 ' + blankCount + ' 道题没填',
        content: '没填的题会记为「未答」，仍然想现在交卷吗？',
        confirmText: '交卷',
        cancelText: '继续答题',
        success: (res) => {
          if (res.confirm) this.submit('manual');
        }
      });
      return;
    }
    this.submit('manual');
  },

  /** 收卷：submitting / submitted 双重标记，保证同一份作答只批改、只跳转一次。 */
  async submit(finishedBy) {
    if (this.submitted || this.data.submitting) return;
    if (!this.questions.length) return;
    this.setData({ submitting: true });
    this.clearTimer();
    this.submitted = true;

    const durationSeconds = Math.max(0, Math.round((Date.now() - this.startTime) / 1000));
    const payload = {
      quizId: this.data.quizId,
      config: this.config,
      answers: buildAnswersView(this.answers),
      durationSeconds: durationSeconds,
      finishedBy: finishedBy === 'timeup' ? 'timeup' : 'manual'
    };

    try {
      const response = await questionService.submitAnswers(payload);
      if (!this.pageActive) return;
      if (!response.ok) {
        this.submitted = false;
        this.setData({ submitting: false });
        wx.showModal({
          title: '提交失败',
          content: response.message || '批改服务暂时不可用，请重试。',
          showCancel: false
        });
        return;
      }
      const result = response.data.result;
      console.log('[practice] 批改结果（' + response.source + '）', result);
      this.result = result;
      try {
        wx.setStorageSync('pendingPracticeResult', result);
      } catch (error) {
        console.warn('[practice] 结果缓存失败', error);
      }
      this.setData({
        submitting: false,
        finished: true,
        reviewMode: true,
        summary: {
          total: result.total,
          correct: result.correct,
          wrong: result.wrong,
          blank: result.blank,
          accuracyPercent: result.accuracyPercent
        },
        navCells: result.questions.map(function (question, index) {
          return { no: index + 1, state: question.verdict };
        })
      });
      this.applyQuestion(this.data.currentIndex);
      if (typeof wx.showToast === 'function') {
        wx.showToast({ title: '已交卷，点击题号可回看', icon: 'none' });
      }
    } catch (error) {
      console.error('[practice] 提交异常', error);
      if (!this.pageActive) return;
      this.submitted = false;
      this.setData({ submitting: false });
      wx.showModal({ title: '提交失败', content: '网络异常，答案还在本页，请再试一次。', showCancel: false });
    }
  },

  /** 回顾状态：点题号跳转；结果页仍由彭方鑫负责，这里只负责把 result 交出去。 */
  openResultPage() {
    const result = this.result;
    if (!result) return;
    wx.navigateTo({
      url: '/pages/result/result',
      success: (res) => {
        if (res.eventChannel) res.eventChannel.emit('result', result);
      },
      fail: () => {
        wx.showToast({ title: '结果页打开失败，可稍后在记录里查看', icon: 'none' });
      }
    });
  },

  /** 返回设置：有上一页就返回；单独打开时带上完整参数恢复设置（与设置页原有行为一致）。 */
  backToSettings() {
    const url = '/pages/settings/settings' + (this.config ? '?' + toQuery(this.config) : '');
    wx.navigateBack({
      delta: 1,
      fail() {
        wx.redirectTo({ url: url });
      }
    });
  },

  retry() {
    if (!this.config) {
      this.backToSettings();
      return;
    }
    this.setData({ loading: true, loadError: '', unavailable: null, currentIndex: 0, submitting: false });
    this.submitted = false;
    this.loadQuiz();
  }
});
