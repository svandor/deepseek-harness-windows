import fs from 'fs';

const src = 'C:/Users/info/.dsh/sessions/--D-Szerver-Antikolt--/session-5d611e3c-6d92-46ab-9299-0b6be904abc8';
const wsTemp = 'D:/Szerver/Deepseek Harness/.dsh-task-temp/session-5d611e3c-6d92-46ab-9299-0b6be904abc8.copy';

function hex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

try {
  const st = fs.statSync(src);
  console.log('SRC_STAT_OK size=' + st.size + ' isFile=' + st.isFile() + ' mtime=' + st.mtime);
} catch (e) {
  console.log('SRC_STAT_FAIL ' + e.message);
}

let used = src;
try {
  const fd = fs.openSync(src, 'r');
  console.log('SRC_OPEN_OK fd=' + fd);
  fs.closeSync(fd);
} catch (e) {
  console.log('SRC_OPEN_FAIL ' + e.message);
  try {
    fs.copyFileSync(src, wsTemp);
    const st2 = fs.statSync(wsTemp);
    console.log('COPY_OK to ' + wsTemp + ' size=' + st2.size);
    used = wsTemp;
  } catch (e2) {
    console.log('COPY_FAIL ' + e2.message);
    process.exit(1);
  }
}

try {
  const fd = fs.openSync(used, 'r');
  const buf = Buffer.alloc(96);
  const n = fs.readSync(fd, buf, 0, 96, 0);
  console.log('HEAD_READ_OK n=' + n);
  console.log('HEAD_HEX: ' + hex(buf.subarray(0, n)));
  fs.closeSync(fd);
} catch (e) {
  console.log('HEAD_READ_FAIL ' + e.message);
}
