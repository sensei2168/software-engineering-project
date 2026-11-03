const { judgeQuestion, answerText } = require('./exact-answer');
function initialize(room) {
  if (!room.attempt.players) room.attempt.players = room.members.map(m => ({ userId: m.userId, role: m.role, answers: {}, finishedAt: null }));
  return room.attempt.players;
}
function ownPlayer(room, userId) { return initialize(room).find(p => p.userId === userId); }
function settle(room, time) {
  if (room.status !== 'active' || !room.attempt) return false;
  const players = initialize(room), attempt = room.attempt;
  if (time < attempt.endAt && !players.every(p => p.finishedAt !== null)) return false;
  const finishedAt = Math.min(time, attempt.endAt);
  const scores = players.map(p => {
    const accepted = Object.values(p.answers), correct = accepted.filter(a => a.correct).length;
    return { role: p.role, score: correct * 10, correct, wrong: accepted.length - correct,
      unanswered: attempt.questions.length - accepted.length, total: attempt.questions.length,
      accuracyText: (correct / attempt.questions.length * 100).toFixed(1) + '%' };
  });
  attempt.result = { version: 1, finishedAt, reason: time >= attempt.endAt ? 'timeout' : 'both_finished', scores,
    winnerRole: scores[0].score === scores[1].score ? null : scores.reduce((a,b) => a.score > b.score ? a : b).role };
  room.status = 'finished'; room.version++; room.purgeAt = finishedAt + 24 * 60 * 60 * 1000;
  return true;
}
function progress(room, userId) {
  const players = initialize(room), own = ownPlayer(room, userId);
  return { self: { finished: own.finishedAt !== null, answers: Object.entries(own.answers).map(([questionId,a]) => ({ questionId, answer: a.answer, acceptedAt: a.acceptedAt })) },
    players: players.map(p => ({ role: p.role, submitted: Object.keys(p.answers).length, finished: p.finishedAt !== null })) };
}
function resultFor(room, userId) {
  const attempt = room.attempt, result = attempt.result;
  if (room.status !== 'finished' || !result) return null;
  const own = ownPlayer(room, userId);
  return { ...result, recordId: 'match-' + room.roomId + '-' + attempt.attemptId + '-' + userId,
    selfRole: own.role, outcome: result.winnerRole === null ? 'draw' : result.winnerRole === own.role ? 'win' : 'lose',
    items: attempt.questions.map(q => {
      const submitted = own.answers[q.id];
      return { expression: q.text, question: q, correctAnswer: answerText(q), userAnswer: submitted ? submitted.answer : '',
        status: !submitted ? 'unanswered' : submitted.correct ? 'correct' : 'wrong' };
    }) };
}
module.exports = { initialize, ownPlayer, settle, progress, resultFor, judgeQuestion };
