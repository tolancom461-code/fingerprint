import { hashPassword } from '../src/infrastructure/portal/auth.js';

// Only the salted hash goes to stdout. Passwords are never accepted as arguments.
try {
  let password = '';
  if (!process.stdin.isTTY || process.argv.includes('--stdin')) {
    for await (const chunk of process.stdin) {
      password += chunk.toString('utf8');
      if (Buffer.byteLength(password) > 8192) throw new Error('Password input is too long');
    }
    password = password.replace(/\r?\n$/, '');
  } else {
    process.stderr.write('كلمة المرور الجديدة (12 حرفًا على الأقل، لن تظهر أثناء الكتابة): ');
    password = await hiddenInput();
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
} catch {
  process.stderr.write('تعذر إنشاء البصمة. استخدم كلمة مرور من 12 إلى 256 حرفًا وبحد أقصى 1024 بايت، ولا تمررها ضمن سطر الأوامر.\n');
  process.exitCode = 1;
}

function hiddenInput() {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); };
    const onData = data => {
      for (const character of data) {
        if (character === '\u0003') { cleanup(); reject(new Error('Cancelled')); return; }
        if (character === '\r' || character === '\n') { cleanup(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (character >= ' ' && character !== '\u001b') value += character;
        if (value.length > 256) { cleanup(); reject(new Error('Too long')); return; }
      }
    };
    process.stdin.on('data', onData);
  });
}
