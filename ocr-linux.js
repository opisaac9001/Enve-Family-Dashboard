import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 30000) child.kill();
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error('The file could not be read. Try a clearer image or PDF.'));
    });
  });
}

export async function extractLinuxDocumentText(bytes) {
  const directory = await mkdtemp(join(tmpdir(), 'enve-import-'));
  try {
    const isPdf = bytes.subarray(0, 4).toString() === '%PDF';
    const isWebp = bytes.subarray(0, 4).toString() === 'RIFF';
    const file = join(
      directory,
      isPdf
        ? 'document.pdf'
        : isWebp
          ? 'image.webp'
          : bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
            ? 'image.png'
            : 'image.jpg',
    );
    await writeFile(file, bytes);
    let text;
    if (isPdf) {
      text = await run('pdftotext', ['-f', '1', '-l', '5', '-layout', file, '-']);
      if (!text.trim()) {
        await run('pdftoppm', [
          '-f',
          '1',
          '-l',
          '5',
          '-r',
          '150',
          '-png',
          file,
          join(directory, 'page'),
        ]);
        const pages = (await readdir(directory))
          .filter((name) => /^page-\d+\.png$/.test(name))
          .sort();
        text = (
          await Promise.all(
            pages.map((name) => run('tesseract', [join(directory, name), 'stdout'])),
          )
        ).join('\n\n');
      }
    } else {
      let image = file;
      if (isWebp) {
        image = join(directory, 'image.png');
        await run('dwebp', [file, '-o', image]);
      }
      text = await run('tesseract', [image, 'stdout']);
    }
    if (!text.trim()) throw new Error('No text was found in that file.');
    return text.trim().slice(0, 20000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
