@echo off
REM A harness ujrainditasa a plugin SAJAT helper?vel (lev?lasztva fut, ez?rt
REM t?l?li a szerver le?ll?s?t). A delay 4 s: addig a valasz meg?rkezik.
node "C:\Szerver\Deepseek Harness\plugins\dsh-ui-extras\restart-node.js" 3080 "C:\Users\info\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai\dsh\lib\bin.js" "C:\Users\info\.dsh" 4000 >> "C:\Szerver\Deepseek Harness\state\restart.log" 2>&1
