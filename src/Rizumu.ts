import { AudioPlayerStatus, createAudioPlayer, NoSubscriberBehavior, createAudioResource, StreamType, AudioPlayer } from '@discordjs/voice';
import { BrowserWindow, ipcMain, webContents } from 'electron';
import { Readable } from 'stream';
import * as uuid from 'uuid';
import { BrowserContainer } from './BrowserContainer';
import ProviderManager from './providers/ProviderManager';
import { RizumuProvider } from './providers/RizumuProvider';
import RizumuItem from './RizumuItem';


export type ProgressCallback = (data: { message: string }) => void;

export type RizumuOptions = {
    headless: boolean;
    providers: RizumuProvider[];
};

class Rizumu {

    private _instanceId: string;

    public get instanceId() {
        return this._instanceId;
    }

    private _headless: boolean;

    private _isAlive: boolean = true;
    private _isReady: boolean = false;
    //private _onReady: Function[] = [];
    private _queue: RizumuItem[] = [];
    private _isBusy: boolean = false;
    private _playingItem?: RizumuItem;
    private _onUrlChanged: Array<(url: string) => void> = [];
    private _loopSingle: boolean = false;
    private _audioStream?: Readable;

    private _player?: AudioPlayer;

    private providers: ProviderManager = new ProviderManager();

    private browser: BrowserContainer;

    constructor(options: RizumuOptions) {
        const instanceId = uuid.v4();

        this._instanceId = instanceId;
        this._headless = options.headless;

        for (const provider of options.providers) {
            this.providers.registerProvider(provider);
        }

        /*
        const win = new BrowserWindow({
            width: 450,
            height: 400,
            show: !this._headless,
            webPreferences: {
                preload: path.join(__dirname, '../src/renderer', 'rizumu-preload.js'),
                webviewTag: true,
                offscreen: this._headless,
                sandbox: false
            }
        })

        win.webContents.setFrameRate(10)

        const url = 'file://' + path.join(__dirname, `../src/public/rizumu.html`) + `?instance_id=${instanceId}`;
        win.loadURL(url);
        */
        this.browser = new BrowserContainer(this._headless, this.instanceId, "BROWSER");

        ipcMain.on(`st-console-message-${instanceId}`, (e, arg) => {

            console.log(`[${instanceId}] ${arg.message}`);
        });

        this._log("audio-data listening on " + `audio-data-${instanceId}`);
        ipcMain.on(`audio-data-${instanceId}`, (event, arg) => {

            if (!arg) return;

            const arrayBuffer = arg;

            const samplesBuffer = Buffer.from(arrayBuffer);

            this._audioStream?.push(samplesBuffer);
        });

        /*
        this._onApi('st-ready', () => {
            this._log("ready")
            this._isReady = true;
            for (let res of this._onReady) {
                res();
            }
            this._onReady.splice(0);
        });
        */

        this._onApi('st-video-end', () => {
            this._log(`st-video-end`);
            if (this._loopSingle && this._playingItem) {
                this._playItemAsync(this._playingItem);
            } else {
                this._playingItem = undefined;
                this._updatePlayingItem();
            }
        });

        this._onApi<{ url: string }>('st-url-changed', data => {
            this._log(`st-url-changed ${data.url}`);
            for (let res of this._onUrlChanged) {
                res(data.url);
            }
            this._onUrlChanged.splice(0);
        });
    }

    getAudioPlayer() {
        if (this._player) return this._player;

        const player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
                maxMissedFrames: 5000 / 20
            }
        });

        player.on('error', error => {
            this._log(error);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            this._log('[MAIN] AudioPlayer: Idle');
            this._renewAudioResource();
        });

        player.on(AudioPlayerStatus.Buffering, () => {
            this._log('[MAIN] AudioPlayer: Buffering');
        });

        player.on(AudioPlayerStatus.Playing, () => {
            this._log('[MAIN] AudioPlayer: Playing');
        });

        player.on(AudioPlayerStatus.AutoPaused, () => {
            this._log('[MAIN] AudioPlayer: AutoPaused');
        });

        player.on(AudioPlayerStatus.Paused, () => {
            this._log('[MAIN] AudioPlayer: Paused');
        });

        this._player = player;
        this._renewAudioResource();

        return this._player;
    }

    getPlayingItem() {
        return this._playingItem;
    }

    getQueue() {
        return this._queue;
    }

    getLoopSingle() {
        return this._loopSingle;
    }

    setLoopSingle(loopSingle: boolean) {
        this._loopSingle = loopSingle;
    }

    private _renewAudioResource() {
        const rawStream = this.getAudioStream();

        const resource = createAudioResource(rawStream, {
            inputType: StreamType.Raw,
            //inlineVolume: true
        });
        //resource.volume.setVolume(0.2);

        this._player!.play(resource);
    }

    enqueueItem(item: RizumuItem, autoplay: boolean) {
        this._queue.push(item);
        if (autoplay)
            this._updatePlayingItem();
    }

    getAudioStream() {
        this._audioStream = new Readable({
            read() { }
        });
        return this._audioStream;
    }

    isAlive() {
        return this._isAlive && this.browser.isAlive;// !this._window.isDestroyed();
    }

    close() {
        if (this.isAlive()) {
            //this._window.close();
            this.browser.close();
            this._isAlive = false;
        }
    }

    /*
    readyAsync() {
        if (this._isReady) {
            return new Promise((res, rej) => {
                res(undefined);
            });
        } else {
            return new Promise((res, rej) => {
                this._onReady.push(res);
            });
        }
    }
    */

    captureAsync() {
        return new Promise<Buffer>((res, rej) => {
            const c = this.browser.currentWebContents;
            if (c) {
                c.once('paint', (event, dirty, image) => {
                    res(image.toPNG());
                });
            } else {
                rej();
            }
        });
    }

    async pushUrlAsync(url: URL, progress?: ProgressCallback) {
        if (this._isBusy) {
            throw new Error('別の処理が実行中です。');
        }
        this._isBusy = true;
        try {
            await this.providers.processAsync(url, (item) => {
                this.enqueueItem(item, true);
            }, progress);
        } finally {
            this._isBusy = false;
        }
    }

    private async _updatePlayingItem() {
        if (this._playingItem) return;
        await this.moveQueueAsync(0);
    }

    async moveQueueAsync(position: number) {
        if (position >= 0) this._queue.splice(0, position);
        if (this._queue.length == 0) {
            //empty
            this._log("the queue has been emptied.");
            this.browser.close();
        } else {

            await this._playItemAsync(this._queue[0]);
            this._queue.splice(0, 1);
        }
    }

    async playUrlAsync(url: URL, preloadPath: string) {
        this._log(`playing ${url.toString()}`);
        /*
        this._sendApi('op-play-watch',
            {
                url: url.toString(),
                preload: preloadPath
            });
            */

        this.browser.open(url.toString(), preloadPath);
        /*
    const newUrl = await this._waitForUrlAsync();
    if (newUrl !== url.toString()) throw new Error(`Failed to navigate: ${url.toString()}`);
    */
    }

    private async _playItemAsync(item: RizumuItem) {
        this._playingItem = item;

        this.providers.playItemAsync(this, item);

    }

    /*
    private _waitForUrlAsync() {
        this._log(`_waitForUrlAsync(): waiting for next url`);
        return new Promise<string>((res, rej) => {
            this._onUrlChanged.push((url) => {
                this._log(`_waitForUrlAsync(): resolved: ${url}`);
                res(url);
            });
        })
    }
    */

    /*
    private _sendApi(eventName: string, data: any) {
        const channel = `${eventName}-${this._instanceId}`;
        console.log(`[RIZUMU] sending on ${channel}`);
        //this._window.webContents.send(channel, data);
        this.browser.currentWebContents?.send(channel, data);
    }
    */

    private _onApi<T>(eventName: string, listener: (arg: T) => void) {
        const channel = `${eventName}-${this._instanceId}`;
        console.log(`[RIZUMU] listening on ${channel}`);
        ipcMain.on(channel, (event, arg) => {
            listener(arg);
        });
    }

    private _log(message: any) {
        console.log(`[${this._instanceId}] [RIZUMU] ${message}`)
    }
}

export default Rizumu;