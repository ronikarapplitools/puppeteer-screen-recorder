import { EventEmitter } from 'events';

import { CDPSession, Page } from 'puppeteer';

import { Logger, PuppeteerScreenRecorderOptions } from './PageVideoStreamTypes';

/**
 * @ignore
 */
export class pageVideoStreamCollector extends EventEmitter {
  private _page: Page;
  private _options: PuppeteerScreenRecorderOptions;
  private _sessionsStack: [CDPSession?] = [];
  private _isStreamingEnded = false;
  private readonly _logger: Logger

  private _isFrameAckReceived: Promise<void>;

  constructor(page: Page, options: PuppeteerScreenRecorderOptions, logger: Logger) {
    super();
    this._page = page;
    this._options = options;
    this._logger = logger
  }

  private get _shouldFollowPopupWindow(): boolean {
    return this._options.followNewTab;
  }

  public async start(): Promise<void> {
    await this._startSession(this._page);
    this._page.once('close', async () => await this._endSession());

    if (this._shouldFollowPopupWindow) {
      this._addListenerOnTabOpens(this._page);
    }
  }

  public async stop(): Promise<boolean> {
    if (this._isStreamingEnded) {
      return this._isStreamingEnded;
    }

    if (this._shouldFollowPopupWindow) {
      this._removeListenerOnTabClose(this._page);
    }

    await Promise.race([
      this._isFrameAckReceived,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);

    this._isStreamingEnded = true;

    try {
      for (const currentSession of this._sessionsStack) {
        await currentSession.detach();
      }
    } catch (e) {
      console.warn('Error detaching session', e.message);
    }

    return true;
  }

  private async _getPageSession(page: Page): Promise<CDPSession | null> {
    try {
      const context = page.target();
      return await context.createCDPSession();
    } catch (error) {
      console.log('Failed to create CDP Session', error);
      return null;
    }
  }

  private _getCurrentSession(): CDPSession | null {
    return this._sessionsStack[this._sessionsStack.length - 1];
  }

  private _addListenerOnTabOpens(page: Page): void {
    page.on('popup', (newPage) => this._registerTabListener(newPage));
  }

  private _removeListenerOnTabClose(page: Page): void {
    page.off('popup', (newPage) => this._registerTabListener(newPage));
  }

  private async _registerTabListener(newPage: Page): Promise<void> {
    await this._startSession(newPage);
    newPage.once('close', async () => await this._endSession());
  }

  private async _startScreenCast(shouldDeleteSessionOnFailure = false) {
    const currentSession = this._getCurrentSession();
    const quality = Number.isNaN(this._options.quality)
      ? 100
      : Math.max(Math.min(this._options.quality, 100), 0);
    try {
      await currentSession.send('Animation.setPlaybackRate', {
        playbackRate: 1,
      });
      await currentSession.send('Page.startScreencast', {
        everyNthFrame: 1,
        format: this._options.format || 'jpeg',
        quality: quality,
      });

      this._logger.info({action: 'start-screencast'})
    } catch (e) {
      this._logger.info({action: 'start-screencast', error: e.stack})

      if (shouldDeleteSessionOnFailure) {
        this._endSession();
      }
    }
  }

  private async _stopScreenCast() {
    const currentSession = this._getCurrentSession();
    if (!currentSession) {
      return;
    }
    await currentSession.send('Page.stopScreencast');
  }

  private async _startSession(page: Page): Promise<void> {
    const pageSession = await this._getPageSession(page);
    if (!pageSession) {
      return;
    }
    await this._stopScreenCast();
    this._sessionsStack.push(pageSession);
    this._handleScreenCastFrame(pageSession);
    await this._startScreenCast(true);
  }

  private async _handleScreenCastFrame(session) {
    this._isFrameAckReceived = new Promise((resolve) => {
      session.on(
        'Page.screencastFrame',
        async ({ metadata, data, sessionId }) => {
          if (!metadata.timestamp || this._isStreamingEnded) {
            return resolve();
          }

          const ackPromise = session.send('Page.screencastFrameAck', {
            sessionId: sessionId,
          });

          this.emit('pageScreenFrame', {
            data,
            metadata
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

  private async _endSession(): Promise<void> {
    this._sessionsStack.pop();
    await this._startScreenCast();
  }
}
