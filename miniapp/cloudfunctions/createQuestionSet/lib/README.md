# 云函数 lib/：与小程序端逐字节相同的出题/判分模块

`lib/generator.js`、`lib/scoring.js`、`lib/session-core.js` 与 `miniapp/utils/question/` 下的同名文件**内容完全一致**；
`practice-rules.js` 与 `miniapp/utils/practice-rules.js` 完全一致。

云函数部署时只会上传 `createQuestionSet/` 整个目录，所以要在这里放一份；两边各跑一份，
小程序端用于本地兜底和预览，云函数端用于正式出题与判分。

改动后必须同步，否则会出现「本地通过、云端不一致」。在仓库根目录执行：

```powershell
Copy-Item miniapp/miniapp/utils/question/generator.js    miniapp/cloudfunctions/createQuestionSet/lib/ -Force
Copy-Item miniapp/miniapp/utils/question/scoring.js      miniapp/cloudfunctions/createQuestionSet/lib/ -Force
Copy-Item miniapp/miniapp/utils/question/session-core.js miniapp/cloudfunctions/createQuestionSet/lib/ -Force
Copy-Item miniapp/miniapp/utils/practice-rules.js        miniapp/cloudfunctions/createQuestionSet/ -Force
```

（上面路径按「外层仓库 / 小程序目录」写成 `miniapp/miniapp/...`；如果你的工作目录已经在 `miniapp/`，把每行开头的 `miniapp/` 去掉。）

`node --test tests/question.test.cjs` 的最后一组用例会逐字节比对，忘记同步会直接失败。
