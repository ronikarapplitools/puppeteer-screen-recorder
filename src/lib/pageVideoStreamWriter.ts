import { EventEmitter } from 'events';
import os from 'os';
import { extname } from 'path';
import { PassThrough, Writable } from 'stream';

import ffmpeg, { setFfmpegPath } from 'fluent-ffmpeg';
import sharp from 'sharp'


import {
  PageScreenFrame,
  RawFrame,
  SupportedFileFormats,
  VIDEO_WRITE_STATUS,
  VideoOptions,
} from './pageVideoStreamTypes';

/**
 * @ignore
 */
const SUPPORTED_FILE_FORMATS = [
  SupportedFileFormats.MP4,
  SupportedFileFormats.AVI,
  SupportedFileFormats.MOV,
  SupportedFileFormats.WEBM,
];

/**
 * @ignore
 */
export default class PageVideoStreamWriter extends EventEmitter {
  private readonly _screenLimit = 40;
  private _screenCastFrames = [];
  public duration = '00:00:00:00';

  private _status = VIDEO_WRITE_STATUS.NOT_STARTED;
  private _options: VideoOptions;

  private _videoMediatorStream: PassThrough = new PassThrough();
  private _writerPromise: Promise<boolean>;

  constructor(destinationSource: string | Writable, options?: VideoOptions) {
    super();

    if (options) {
      this._options = options;
    }

    const isWritable = this._isWritableStream(destinationSource);
    this._configureFFmPegPath();
    if (isWritable) {
      this._configureVideoWritableStream(destinationSource as Writable);
    } else {
      this._configureVideoFile(destinationSource as string);
    }
  }

  private get _videoFrameSize(): string {
    const { width, height } = this._options.videoFrame;

    return width !== null && height !== null ? `${width}x${height}` : '100%';
  }

  private get _autopad(): { activation: boolean; color?: string } {
    const autopad = this._options.autopad;

    return !autopad
      ? { activation: false }
      : { activation: true, color: autopad.color };
  }

  public async insert({data, metadata}: RawFrame): Promise<void> {
    const frame = await this._createPageScreenFrame({data,metadata})

     // reduce the queue into half when it is full
    if (this._screenCastFrames.length === this._screenLimit) {
      const numberOfFramesToSplice = Math.floor(this._screenLimit / 2);
      const framesToProcess = this._screenCastFrames.splice(
        0,
        numberOfFramesToSplice
      );
      this._processFrameBeforeWrite(framesToProcess, this._screenCastFrames[0].timestamp);
    }

    const insertionIndex = this._findSlot(frame.timestamp);

    if (insertionIndex === this._screenCastFrames.length) {
      this._screenCastFrames.push(frame);
    } else {
      this._screenCastFrames.splice(insertionIndex, 0, frame);
    }
  }

  public write(data: Buffer, durationSeconds = 1): void {
    this._status = VIDEO_WRITE_STATUS.IN_PROGRESS;

    const NUMBER_OF_FPS = Math.max(
      Math.floor(durationSeconds * this._options.fps),
      1
    );

    for (let i = 0; i < NUMBER_OF_FPS; i++) {
      this._videoMediatorStream.write(data);
    }
  }

  public stop(stoppedTime = Date.now() / 1000): Promise<boolean> {
    if (this._status === VIDEO_WRITE_STATUS.COMPLETED) {
      return this._writerPromise;
    }

    this._drainFrames(stoppedTime);

    this._videoMediatorStream.end();
    this._status = VIDEO_WRITE_STATUS.COMPLETED;
    return this._writerPromise;
  }

  private _getFfmpegPath(): string | null {
    if (this._options.ffmpeg_Path) {
      return this._options.ffmpeg_Path;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpeg = require('@ffmpeg-installer/ffmpeg');
      if (ffmpeg.path) {
        return ffmpeg.path;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  private _getDestinationPathExtension(destinationFile): SupportedFileFormats {
    const fileExtension = extname(destinationFile);
    return fileExtension.includes('.')
      ? (fileExtension.replace('.', '') as SupportedFileFormats)
      : (fileExtension as SupportedFileFormats);
  }

  private _configureFFmPegPath(): void {
    const ffmpegPath = this._getFfmpegPath();

    if (!ffmpegPath) {
      throw new Error(
        'FFmpeg path is missing, \n Set the FFMPEG_PATH env variable'
      );
    }

    setFfmpegPath(ffmpegPath);
  }

  private _isWritableStream(destinationSource: string | Writable): boolean {
    if (destinationSource && typeof destinationSource !== 'string') {
      if (
        !(destinationSource instanceof Writable) ||
        !('writable' in destinationSource) ||
        !destinationSource.writable
      ) {
        throw new Error('Output should be a writable stream');
      }
      return true;
    }
    return false;
  }

  private _configureVideoFile(destinationPath: string): void {
    const fileExt = this._getDestinationPathExtension(destinationPath);

    if (!SUPPORTED_FILE_FORMATS.includes(fileExt)) {
      throw new Error('File format is not supported');
    }

    this._writerPromise = new Promise((resolve) => {
      const outputStream = this._getDestinationStream();

      outputStream
        .on('error', (e) => {
          this._handleWriteStreamError(e.message);
          resolve(false);
        })
        .on('end', () => resolve(true))
        .save(destinationPath);

      if (fileExt == SupportedFileFormats.WEBM) {
        outputStream
          .videoCodec('libvpx')
          .videoBitrate(this._options.videoBitrate || 1000, true)
          .outputOptions('-flags', '+global_header', '-psnr');
      }
    });
  }

  private _configureVideoWritableStream(writableStream: Writable) {
    this._writerPromise = new Promise((resolve) => {
      const outputStream = this._getDestinationStream();

      outputStream
        .on('error', (e) => {
          writableStream.emit('error', e);
          resolve(false);
        })
        .on('end', () => {
          writableStream.end();
          resolve(true);
        });

      outputStream.toFormat('mp4');
      outputStream.addOutputOptions(
        '-movflags +frag_keyframe+separate_moof+omit_tfhd_offset+empty_moov'
      );
      outputStream.pipe(writableStream);
    });
  }

  private _getDestinationStream(): ffmpeg {
    const cpu = Math.max(1, os.cpus().length - 1);
    const outputStream = ffmpeg({
      source: this._videoMediatorStream,
      priority: 20,
    })
      .videoCodec(this._options.videoCodec || 'libx264')
      .size(this._videoFrameSize)
      .aspect(this._options.aspectRatio || '4:3')
      .autopad(this._autopad.activation, this._autopad?.color)
      .inputFormat('image2pipe')
      .inputFPS(this._options.fps)
      .outputOptions(`-crf ${this._options.videoCrf ?? 23}`)
      .outputOptions(`-preset ${this._options.videoPreset || 'ultrafast'}`)
      .outputOptions(`-pix_fmt ${this._options.videoPixelFormat || 'yuv420p'}`)
      .outputOptions(`-minrate ${this._options.videoBitrate || 1000}`)
      .outputOptions(`-maxrate ${this._options.videoBitrate || 1000}`)
      .outputOptions('-framerate 1')
      .outputOptions(`-threads ${cpu}`)
      .on('progress', (progressDetails) => {
        this.duration = progressDetails.timemark;
      });

    if (this._options.recordDurationLimit) {
      outputStream.duration(this._options.recordDurationLimit);
    }

    return outputStream;
  }

  private _handleWriteStreamError(errorMessage): void {
    this.emit('videoStreamWriterError', errorMessage);

    if (
      this._status !== VIDEO_WRITE_STATUS.IN_PROGRESS &&
      errorMessage.includes('pipe:0: End of file')
    ) {
      return;
    }
    return console.error(
      `Error unable to capture video stream: ${errorMessage}`
    );
  }

  private _findSlot(timestamp: number): number {
    if (this._screenCastFrames.length === 0) {
      return 0;
    }

    let i: number;
    let frame: PageScreenFrame;

    for (i = this._screenCastFrames.length - 1; i >= 0; i--) {
      frame = this._screenCastFrames[i];

      if (timestamp > frame.timestamp) {
        break;
      }
    }

    return i + 1;
  }

  private _trimFrame(fameList: PageScreenFrame[], chunckEndTime: number): PageScreenFrame[] {
    return fameList.map((currentFrame: PageScreenFrame, index: number) => {
      const endTime = (index !== fameList.length-1) ? fameList[index+1].timestamp : chunckEndTime;
      const duration = endTime - currentFrame.timestamp; 
        
      return {
        ...currentFrame,
        duration,
      };
    });
  }

  private _processFrameBeforeWrite(frames: PageScreenFrame[], chunckEndTime: number): void {
    const processedFrames = this._trimFrame(frames, chunckEndTime);

    processedFrames.forEach(({ blob, duration }) => {
      this.write(blob, duration);
    });
  }

  private async _createPageScreenFrame({data, metadata}: RawFrame){
    let blob
    const {deviceHeight, deviceWidth, timestamp} = metadata;

    if (this._options.saveFrameSize){
      const image = sharp(Buffer.from(data, 'base64'));
      if (deviceWidth && deviceHeight){
        image.resize({ width:metadata.deviceWidth, height:metadata.deviceHeight})
        .extract({top:0, left:0, height: Math.min(this._options.videoFrame.height, deviceHeight), width: Math.min(this._options.videoFrame.width, deviceWidth)})
        .extend({
          top: 0,
          bottom: Math.max(this._options.videoFrame.height - deviceHeight,0),
          left: 0,
          right: Math.max(this._options.videoFrame.width - deviceWidth ,0),
          background: this._options.backgroundColor
         })
      }
      
      blob = await image.toFormat('jpeg').toBuffer()
    }else{
      blob = Buffer.from(data, 'base64')
    }

    return {
      timestamp,
      blob
    }
  }

  private _drainFrames(stoppedTime: number): void {
    this._processFrameBeforeWrite(this._screenCastFrames, stoppedTime);
    this._screenCastFrames = [];
  }
}
