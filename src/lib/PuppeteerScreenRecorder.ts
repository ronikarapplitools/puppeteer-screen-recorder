import fs from 'fs';
import { dirname } from 'path';
import { Writable } from 'stream';

import { Page } from 'puppeteer';

import { pageVideoStreamCollector } from './pageVideoStreamCollector';
import { PuppeteerScreenRecorderOptions } from './pageVideoStreamTypes';
import PageVideoStreamWriter from './pageVideoStreamWriter';

/**
 * @ignore
 * @default
 * @description This will be option passed to the puppeteer screen recorder
 */
const defaultPuppeteerScreenRecorderOptions: PuppeteerScreenRecorderOptions = {
  followNewTab: true,
  fps: 25,
  quality: 100,
  ffmpeg_Path: null,
  videoFrame: {
    width: null,
    height: null,
  },
  aspectRatio: '4:3',
  saveFrameSize: false,
  backgroundColor: '#A39DA18C'
};

/**
 * PuppeteerScreenRecorder class is responsible for managing the video
 *
 * ```typescript
 * const screenRecorderOptions = {
 *  followNewTab: true,
 *  fps: 25,
 * }
 * const savePath = "./test/demo.mp4";
 * const screenRecorder = new PuppeteerScreenRecorder(page, screenRecorderOptions);
 * await screenRecorder.start(savePath);
 *  // some puppeteer action or test
 * await screenRecorder.stop()
 * ```
 */
export class PuppeteerScreenRecorder {
  private _page: Page;
  private _options: PuppeteerScreenRecorderOptions;
  private _streamReader: pageVideoStreamCollector;
  private _streamWriter: PageVideoStreamWriter;
  private _isScreenCaptureEnded: boolean | null = null;

  constructor(page: Page, options = {}) {
    this._options = Object.assign(
      {},
      defaultPuppeteerScreenRecorderOptions,
      options
    );
    this._streamReader = new pageVideoStreamCollector(page, this._options);
    this._page = page;
  }

  /**
   * @public
   * @method getRecordDuration
   * @description return the total duration of the video recorded,
   *  1. if this method is called before calling the stop method, it would be return the time till it has recorded.
   *  2. if this method is called after stop method, it would give the total time for recording
   * @returns total duration of video
   */
  public getRecordDuration(): string {
    if (!this._streamWriter) {
      return '00:00:00:00';
    }
    return this._streamWriter.duration;
  }

  /**
   *
   * @public
   * @method start
   * @param savePath accepts a path string to store the video
   * @description Start the video capturing session
   * @returns PuppeteerScreenRecorder
   * @example
   * ```
   *  const savePath = './test/demo.mp4'; //.mp4 is required
   *  await recorder.start(savePath);
   * ```
   */
  public async start(savePath: string): Promise<PuppeteerScreenRecorder> {
    await this._ensureDirectoryExist(dirname(savePath));

    this._streamWriter = new PageVideoStreamWriter(savePath, this._options);
    return this._startStreamReader();
  }

  /**
   *
   * @public
   * @method startStream
   * @description Start the video capturing session in a stream
   * @returns {PuppeteerScreenRecorder}
   * @example
   * ```
   *  const stream = new PassThrough();
   *  await recorder.startStream(stream);
   * ```
   */
  public async startStream(stream: Writable): Promise<PuppeteerScreenRecorder> {
    this._streamWriter = new PageVideoStreamWriter(stream, this._options);
    return this._startStreamReader();
  }

  /**
   * @public
   * @method stop
   * @description stop the video capturing session
   * @returns indicate whether stop is completed correct or not, if true without any error else false.
   */
  public async stop(): Promise<boolean> {
    if (this._isScreenCaptureEnded !== null) {
      return this._isScreenCaptureEnded;
    }

    await this._streamReader.stop();
    this._isScreenCaptureEnded = await this._streamWriter.stop();
    return this._isScreenCaptureEnded;
  }

  /**
   * @ignore
   */
   private _setupListeners(): void {
    this._page.once('close', async () => await this.stop());

    this._streamReader.on('pageScreenFrame', (rawFrame) => {
      this._streamWriter.insert(rawFrame);
    });

    this._streamWriter.once('videoStreamWriterError', () => this.stop());
  }

  /**
   * @ignore
   */
  private async _ensureDirectoryExist(dirPath) {
    return new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
        return resolve(dirPath);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * @ignore
   * @private
   * @method startStreamReader
   * @description start listening for video stream from the page.
   * @returns PuppeteerScreenRecorder
   */
  private async _startStreamReader(): Promise<PuppeteerScreenRecorder> {
    this._setupListeners();

    await this._streamReader.start();
    return this;
  }
}
