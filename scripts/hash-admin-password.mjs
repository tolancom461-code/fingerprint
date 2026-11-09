import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

// Never accept a password on the command line or echo it to stdout/stderr.
try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--stdin') || args.length > 1) throw inputError('INVALID_ARGS');
  const interactive = Boolean(process.stdin.isTTY) && !args.includes('--stdin');
  let password;
  if (interactive) {
    process.stderr.write('أدخل كلمة مرور من 12 إلى 256 حرفًا ثم اضغط Enter (لن تظهر أثناء الكتابة): ');
    password = await hiddenInput();
  } else {
    process.stdin.setEncoding('utf8');
    password = '';
    for await (const chunk of process.stdin) {
      password += chunk;
      if (Buffer.byteLength(password) > 8192) throw inputError('TOO_LONG');
    }
    password = password.replace(/\r\n$|\n$|\r$/, '');
  }
  validate(password);
  try { process.stdout.write(`${await hashPassword(password)}\n`); }
  catch { throw inputError('HASH_FAILED'); }
} catch (error) {
  const messages = {
    INVALID_ARGS: 'شغّل الأداة دون كتابة كلمة المرور ضمن الأمر؛ أدخلها عند ظهور الطلب فقط.',
    EMPTY: 'لم يتم إدخال كلمة مرور. أعد الأمر واكتب كلمة المرور قبل الضغط على Enter.',
    TOO_SHORT: 'كلمة المرور المدخلة أقصر من 12 حرفًا. أعد الأمر واستخدم 12 حرفًا على الأقل.',
    TOO_LONG: 'كلمة المرور أطول من المسموح: الحد 256 حرفًا و1024 بايت UTF-8.',
    MULTILINE: 'الإدخال يحتوي أكثر من سطر. أدخل كلمة مرور واحدة فقط دون فواصل أسطر.',
    PASTE_UNAVAILABLE: 'لم تصل حروف اللصق من الطرفية. أعد الأمر واكتب كلمة المرور يدويًا.',
    CANCELLED: 'تم إلغاء الإدخال، ولم يتم إنشاء أي هاش.',
    INPUT_UNAVAILABLE: 'تعذر قراءة الإدخال المخفي. شغّل الأمر من نافذة PowerShell أو CMD تفاعلية.',
    HASH_FAILED: 'تعذر تشغيل scrypt لإنشاء الهاش. تحقق من تثبيت Node.js؛ لم تُطبع كلمة المرور.'
  };
  process.stderr.write(`${messages[error?.code] || messages.INPUT_UNAVAILABLE}\n`);
  process.exitCode = error?.code === 'CANCELLED' ? 130 : 1;
}

function validate(password) {
  if (!password.length) throw inputError('EMPTY');
  if (/[\r\n]/.test(password)) throw inputError('MULTILINE');
  if (password.length < 12) throw inputError('TOO_SHORT');
  if (password.length > 256 || Buffer.byteLength(password) > 1024) throw inputError('TOO_LONG');
}

function hiddenInput() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rl;
    const wasRaw = Boolean(process.stdin.isRaw);
    // Readline handles Windows editing keys, UTF-8 and bracketed paste. Its
    // terminal output is discarded so the editable secret never reaches a log.
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    try {
      process.stdin.setEncoding('utf8');
      rl = createInterface({ input: process.stdin, output: muted, terminal: true,
        historySize: 0, crlfDelay: Infinity, prompt: '' });
    } catch {
      try { process.stdin.setRawMode?.(wasRaw); } catch {}
      reject(inputError('INPUT_UNAVAILABLE'));
      return;
    }
    const onCancel = () => finish(inputError('CANCELLED'));
    const onError = () => finish(inputError('INPUT_UNAVAILABLE'));
    const guard = chunk => {
      const text = String(chunk).replace(/\x1b\[20[01]~/g, '');
      if (text.includes('\u0016')) return finish(inputError('PASTE_UNAVAILABLE'));
      const withoutFinalEnter = text.replace(/\r\n$|\n$|\r$/, '');
      if (/[\r\n]/.test(withoutFinalEnter)) return finish(inputError('MULTILINE'));
      if (Buffer.byteLength(text) > 8192) finish(inputError('TOO_LONG'));
    };
    function finish(error, password) {
      if (settled) return;
      settled = true;
      process.stdin.off('data', guard); process.stdin.off('error', onError); process.stdin.off('end', onCancel);
      rl.off('SIGINT', onCancel); rl.off('close', onCancel);
      rl.close();
      try { process.stdin.setRawMode?.(wasRaw); } catch {}
      process.stdin.pause();
      muted.end();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(password);
    }
    process.stdin.prependListener('data', guard);
    process.stdin.on('error', onError); process.stdin.on('end', onCancel);
    rl.on('SIGINT', onCancel); rl.on('close', onCancel);
    rl.question('', password => finish(null, password));
  });
}

function inputError(code) { return Object.assign(new Error(code), { code }); }
