import { EventEmitter } from 'events';

import Jimp from 'jimp'
import { CDPSession, Page } from 'puppeteer';

import { PuppeteerScreenRecorderOptions } from './pageVideoStreamTypes';

/**
 * @ignore
 */
export class pageVideoStreamCollector extends EventEmitter {
  private page: Page;
  private options: PuppeteerScreenRecorderOptions;
  private sessionsStack: [CDPSession?] = [];
  private isStreamingEnded = false;

  private isFrameAckReceived: Promise<void>;

  constructor(page: Page, options: PuppeteerScreenRecorderOptions) {
    super();
    this.page = page;
    this.options = options;
  }

  private get shouldFollowPopupWindow(): boolean {
    return this.options.followNewTab;
  }

  private async getPageSession(page: Page): Promise<CDPSession | null> {
    try {
      const context = page.target();
      return await context.createCDPSession();
    } catch (error) {
      console.log('Failed to create CDP Session', error);
      return null;
    }
  }

  private getCurrentSession(): CDPSession | null {
    return this.sessionsStack[this.sessionsStack.length - 1];
  }

  private addListenerOnTabOpens(page: Page): void {
    page.on('popup', (newPage) => this.registerTabListener(newPage));
  }

  private removeListenerOnTabClose(page: Page): void {
    page.off('popup', (newPage) => this.registerTabListener(newPage));
  }

  private async registerTabListener(newPage: Page): Promise<void> {
    await this.startSession(newPage);
    newPage.once('close', async () => await this.endSession());
  }

  private async startScreenCast(shouldDeleteSessionOnFailure = false) {
    const currentSession = this.getCurrentSession();
    const quality = Number.isNaN(this.options.quality)
      ? 100
      : Math.max(Math.min(this.options.quality, 100), 0);
    try {
      await currentSession.send('Animation.setPlaybackRate', {
        playbackRate: 1,
      });
      await currentSession.send('Page.startScreencast', {
        everyNthFrame: 1,
        format: this.options.format || 'jpeg',
        quality: quality,
      });
    } catch (e) {
      if (shouldDeleteSessionOnFailure) {
        this.endSession();
      }
    }
  }

  private async stopScreenCast() {
    const currentSession = this.getCurrentSession();
    if (!currentSession) {
      return;
    }
    await currentSession.send('Page.stopScreencast');
  }

  private async startSession(page: Page): Promise<void> {
    const pageSession = await this.getPageSession(page);
    if (!pageSession) {
      return;
    }
    await this.stopScreenCast();
    this.sessionsStack.push(pageSession);
    this.handleScreenCastFrame(pageSession);
    await this.startScreenCast(true);
  }

  private async handleScreenCastFrame(session) {
    this.isFrameAckReceived = new Promise((resolve) => {
      session.on(
        'Page.screencastFrame',
        async ({ metadata, data, sessionId }) => {
          if (!metadata.timestamp || this.isStreamingEnded) {
            return resolve();
          }

          let blob

          if (this.options.saveFrameSize){
            const image = await (await Jimp.read(Buffer.from(data, 'base64')))
            
            if (metadata.deviceWidth && metadata.deviceHeight){
              image.resize(metadata.deviceWidth, metadata.deviceHeight)
            }
            if (this.options.saveFrameSize){
              const backgroundImage = new Jimp(this.options.videoFrame.width, this.options.videoFrame.width, this.options.backgroundColor)
              blob = await backgroundImage.blit(image, 0, 0).getBufferAsync(Jimp.MIME_JPEG)
             }
          }else{
            blob = Buffer.from(data, 'base64')
          }

          const ackPromise = session.send('Page.screencastFrameAck', {
            sessionId: sessionId,
          });

          this.emit('pageScreenFrame', {
            blob,
            timestamp: metadata.timestamp,
          });

          try {
            await ackPromise;
          } catch (error) {
            console.error(
              'Error in sending Acknowledgment for PageScreenCast',
              error.message
            );
          }
        }
      );
    });
  }

  private async endSession(): Promise<void> {
    this.sessionsStack.pop();
    await this.startScreenCast();
  }

  public async start(): Promise<void> {
    await this.startSession(this.page);
    this.page.once('close', async () => await this.endSession());

    if (this.shouldFollowPopupWindow) {
      this.addListenerOnTabOpens(this.page);
    }
  }

  public async stop(): Promise<boolean> {
    if (this.isStreamingEnded) {
      return this.isStreamingEnded;
    }

    if (this.shouldFollowPopupWindow) {
      this.removeListenerOnTabClose(this.page);
    }

    await Promise.race([
      this.isFrameAckReceived,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);

    this.isStreamingEnded = true;

    try {
      for (const currentSession of this.sessionsStack) {
        await currentSession.detach();
      }
    } catch (e) {
      console.warn('Error detaching session', e.message);
    }

    return true;
  }
}
