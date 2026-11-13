// Renders card.html frame-by-frame into an MP4.
// usage: node render.js out.mp4 [audio.mp3] [--fps 30] [--only t1,t2,... (stills)] [--workers 4]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0];
const audio = args[1] && !args[1].startsWith('--') ? args[1] : null;
const FPS = +opt('--fps', 30);
const WORKERS = +opt('--workers', 4);
const only = opt('--only', null);
const page_url = 'file://' + path.join(__dirname, 'card.html');

async function openPage(browser) {
  const p = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto(page_url);
  const dur = await p.evaluate(() => window.READY);
  return { p, dur };
}
const grab = (p, t) => p.evaluate((t) => { window.renderFrame(t); return document.getElementById('c').toDataURL('image/jpeg', 0.93); }, t);

(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu-vsync'] });
  if (only) {
    const { p } = await openPage(browser);
    for (const t of only.split(',').map(Number)) {
      const d = await grab(p, t);
      fs.writeFileSync(`${out}_${t}.jpg`, Buffer.from(d.split(',')[1], 'base64'));
    }
    await browser.close();
    return;
  }
  const { p: p0, dur } = await openPage(browser);
  await p0.close();
  const N = Math.ceil(dur * FPS);
  console.log(`duration ${dur.toFixed(2)}s, ${N} frames`);
  const per = Math.ceil(N / WORKERS);
  const tmp = out + '.parts';
  fs.mkdirSync(tmp, { recursive: true });
  const t0 = Date.now();
  await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
    const { p } = await openPage(browser);
    const a = w * per, b = Math.min(N, a + per);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', `${tmp}/part${w}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let i = a; i < b; i++) {
      const d = await grab(p, i / FPS);
      const buf = Buffer.from(d.split(',')[1], 'base64');
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (w === 0 && (i - a) % 60 === 0) console.log(`w0 ${i - a}/${b - a}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await new Promise(r => ff.on('close', r));
  }));
  await browser.close();
  fs.writeFileSync(`${tmp}/list.txt`, Array.from({ length: WORKERS }, (_, w) => `file 'part${w}.mp4'`).join('\n'));
  const ffa = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${tmp}/list.txt`];
  if (audio) ffa.push('-i', audio, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k',
    '-af', `afade=t=in:st=0:d=1.5,afade=t=out:st=${(dur - 3.5).toFixed(2)}:d=3.5`, '-t', dur.toFixed(2));
  ffa.push('-c:v', 'copy', '-movflags', '+faststart', out);
  await new Promise((res, rej) => spawn('ffmpeg', ffa, { stdio: 'inherit' }).on('close', c => c ? rej(c) : res()));
  fs.rmSync(tmp, { recursive: true });
  console.log('done', out, ((Date.now() - t0) / 1000).toFixed(0) + 's');
})();
