import { OutputController } from "@/engine/models/OutputController";

/** Parameters accepted by {@link AudioOutputController.trigger}. */
export interface AudioTriggerParams {
    /** Playback volume (0–1). Defaults to the controller's {@link volume}. */
    volume?: number;
    /** Whether to loop the sound. Defaults to `false`. */
    loop?: boolean;
}

/**
 * Plays audio clips via the Web Audio API.
 *
 * Load a clip with {@link load}, then call {@link trigger} to play it.
 * Multiple overlapping plays are supported (each trigger creates a new source node).
 */
export class AudioOutputController extends OutputController {
    private ctx: AudioContext;
    private gain: GainNode;
    private buffer: AudioBuffer | null = null;
    private activeSources = new Set<AudioBufferSourceNode>();
    private currentPlay: { source: AudioBufferSourceNode; env: GainNode } | null = null;
    private _loop = false;

    /** When true, tracks started via {@link crossfadeTo} will loop. */
    get loop(): boolean { return this._loop; }
    set loop(v: boolean) {
        this._loop = v;
        if (this.currentPlay) this.currentPlay.source.loop = v;
    }

    /** Master volume (0–1). */
    get volume(): number {
        return this.gain.gain.value;
    }
    set volume(v: number) {
        this.gain.gain.value = Math.max(0, Math.min(1, v));
    }

    constructor(volume = 1) {
        super();
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
        this.gain.gain.value = volume;
    }

    /** Decodes an ArrayBuffer (e.g. from fetch) and stores it as the active clip. */
    async load(data: ArrayBuffer): Promise<void> {
        this.buffer = await this.ctx.decodeAudioData(data);
    }

    /**
     * Crossfades from whatever is currently playing into the given buffer.
     * If nothing is playing, the new track fades in from silence.
     * @param newBuffer The audio to crossfade into.
     * @param fadeDurationSecs Crossfade duration in seconds (default 3).
     * @param onEnded Optional callback fired when the new track finishes.
     */
    crossfadeTo(newBuffer: AudioBuffer, fadeDurationSecs = 3): void {
        if (this.ctx.state === "suspended") void this.ctx.resume();
        const now = this.ctx.currentTime;

        // Fade out current
        if (this.currentPlay) {
            const { source, env } = this.currentPlay;
            source.loop = false;
            env.gain.cancelScheduledValues(now);
            env.gain.setValueAtTime(env.gain.value, now);
            env.gain.linearRampToValueAtTime(0, now + fadeDurationSecs);
            source.stop(now + fadeDurationSecs);
        }

        // Fade in new
        const source = this.ctx.createBufferSource();
        source.buffer = newBuffer;
        source.loop = this._loop;
        const env = this.ctx.createGain();
        source.connect(env).connect(this.gain);
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(1, now + fadeDurationSecs);

        source.onended = () => {
            this.activeSources.delete(source);
            env.disconnect();
            if (this.currentPlay?.source === source) this.currentPlay = null;
        };
        this.activeSources.add(source);
        this.currentPlay = { source, env };
        source.start();
    }

    /**
     * Decodes an ArrayBuffer into an AudioBuffer using this controller's context.
     * Useful for pre-loading multiple tracks for crossfading.
     */
    async decode(data: ArrayBuffer): Promise<AudioBuffer> {
        return this.ctx.decodeAudioData(data);
    }

    protected onTrigger(params?: unknown): void {
        if (!this.buffer) return;
        const { volume, loop } = (params as AudioTriggerParams | undefined) ?? {};

        // Resume context if suspended (browser autoplay policy).
        if (this.ctx.state === "suspended") void this.ctx.resume();

        const source = this.ctx.createBufferSource();
        source.buffer = this.buffer;
        source.loop = loop ?? false;

        if (volume !== undefined) {
            const perSourceGain = this.ctx.createGain();
            perSourceGain.gain.value = Math.max(0, Math.min(1, volume));
            source.connect(perSourceGain).connect(this.gain);
        } else {
            source.connect(this.gain);
        }

        source.onended = () => this.activeSources.delete(source);
        this.activeSources.add(source);
        source.start();
    }

    stop(): void {
        for (const s of this.activeSources) {
            s.stop();
            s.disconnect();
        }
        this.activeSources.clear();
    }

    dispose(): void {
        this.stop();
        this.buffer = null;
        void this.ctx.close();
    }
}
