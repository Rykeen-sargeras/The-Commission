'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function abortError() {
    const error = new Error('Speech generation was cancelled.');
    error.name = 'AbortError';
    return error;
}

function transcodeWavToOpus(wav, speed, signal, spawnImpl = spawn) {
    if (!ffmpegPath) return Promise.reject(new Error('The bundled FFmpeg executable is unavailable.'));
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const child = spawnImpl(ffmpegPath, [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostdin',
            '-f', 'wav',
            '-i', 'pipe:0',
            '-filter:a', `atempo=${Number(speed).toFixed(2)}`,
            '-c:a', 'libopus',
            '-b:a', '64k',
            '-vbr', 'on',
            '-f', 'ogg',
            'pipe:1',
        ], { windowsHide: true });
        const output = [];
        const errors = [];
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => {
            child.kill('SIGKILL');
            finish(reject, abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', chunk => output.push(chunk));
        child.stderr.on('data', chunk => errors.push(chunk));
        child.on('error', error => finish(reject, error));
        child.on('close', code => {
            if (settled) return;
            if (code !== 0) {
                const detail = Buffer.concat(errors).toString('utf8').trim();
                return finish(reject, new Error(`Audio conversion failed${detail ? `: ${detail}` : '.'}`));
            }
            finish(resolve, Buffer.concat(output));
        });
        child.stdin.on('error', error => {
            if (error.code !== 'EPIPE') finish(reject, error);
        });
        child.stdin.end(wav);
    });
}

class NeuttsSynthesizer {
    constructor(options = {}) {
        this.hfToken = options.hfToken ?? process.env.HF_TOKEN ?? '';
        this.python = options.python ?? process.env.PYTHON_BIN ?? 'python3';
        this.workerPath = options.workerPath ?? path.join(__dirname, 'neutts_worker.py');
        this.backbone = String(options.backbone ?? process.env.TTS_BACKBONE_REPO ?? '').trim()
            || 'neuphonic/neutts-2e-q4-gguf';
        this.codec = String(options.codec ?? process.env.TTS_CODEC_REPO ?? '').trim()
            || 'neuphonic/neucodec-onnx-decoder-int8';
        this.cacheDir = options.cacheDir
            ?? process.env.HF_HOME
            ?? path.join(process.env.DATA_DIR || os.tmpdir(), 'huggingface');
        this.spawnImpl = options.spawnImpl || spawn;
        this.transcode = options.transcode || transcodeWavToOpus;
        this.worker = null;
        this.stdoutBuffer = '';
        this.nextId = 1;
        this.pending = new Map();
        this.closing = false;
    }

    isConfigured() {
        return Boolean(this.hfToken);
    }

    ensureWorker() {
        if (this.worker) return this.worker;
        if (!this.isConfigured()) {
            throw new Error('Add a free Hugging Face read token as HF_TOKEN in Railway before using Discord voice playback.');
        }
        this.closing = false;
        const worker = this.spawnImpl(this.python, ['-u', this.workerPath], {
            env: {
                ...process.env,
                HF_TOKEN: this.hfToken,
                HF_HOME: this.cacheDir,
                HF_HUB_DISABLE_TELEMETRY: '1',
                TTS_BACKBONE_REPO: this.backbone,
                TTS_CODEC_REPO: this.codec,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.worker = worker;
        worker.stdout.setEncoding('utf8');
        worker.stdout.on('data', chunk => this.onStdout(chunk));
        worker.stderr.setEncoding('utf8');
        worker.stderr.on('data', chunk => {
            for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.error(`[NeuTTS] ${line}`);
        });
        worker.on('error', error => this.rejectAll(error));
        worker.on('exit', (code, signal) => {
            if (this.worker === worker) this.worker = null;
            if (!this.closing) {
                this.rejectAll(new Error(`NeuTTS worker stopped unexpectedly (code ${code ?? 'n/a'}, signal ${signal || 'none'}).`));
            }
        });
        return worker;
    }

    onStdout(chunk) {
        this.stdoutBuffer += chunk;
        let newline;
        while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                console.error(`[NeuTTS] Ignored non-JSON worker output: ${line}`);
                continue;
            }
            const request = this.pending.get(message.id);
            if (!request) {
                if (message.ok && message.audioPath) void fs.unlink(message.audioPath).catch(() => {});
                continue;
            }
            this.pending.delete(message.id);
            clearTimeout(request.timer);
            request.cleanup();
            if (message.ok) request.resolve(message);
            else request.reject(new Error(message.error || 'NeuTTS speech generation failed.'));
        }
    }

    rejectAll(error) {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.cleanup();
            request.reject(error);
        }
        this.pending.clear();
    }

    request(payload, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        let worker;
        try {
            worker = this.ensureWorker();
        } catch (error) {
            return Promise.reject(error);
        }
        const id = String(this.nextId++);
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                const request = this.pending.get(id);
                if (!request) return;
                this.pending.delete(id);
                clearTimeout(request.timer);
                request.cleanup();
                reject(abortError());
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            const timer = setTimeout(() => {
                if (!this.pending.delete(id)) return;
                cleanup();
                reject(new Error('NeuTTS took too long to generate speech.'));
            }, 15 * 60_000);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer, cleanup });
            signal?.addEventListener('abort', onAbort, { once: true });
            worker.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => {
                if (!error) return;
                const request = this.pending.get(id);
                if (!request) return;
                this.pending.delete(id);
                clearTimeout(request.timer);
                request.cleanup();
                reject(error);
            });
        });
    }

    async synthesize({ text, voice, speed, signal }) {
        const result = await this.request({ action: 'synthesize', text, speaker: voice, emotion: 'neutral' }, signal);
        let wav;
        try {
            wav = await fs.readFile(result.audioPath);
        } finally {
            if (result.audioPath) await fs.unlink(result.audioPath).catch(() => {});
        }
        return this.transcode(wav, speed, signal);
    }

    destroy() {
        this.closing = true;
        this.rejectAll(new Error('NeuTTS worker is shutting down.'));
        this.worker?.kill('SIGTERM');
        this.worker = null;
    }
}

module.exports = { NeuttsSynthesizer, transcodeWavToOpus };
