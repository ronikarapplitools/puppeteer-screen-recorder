import sharp from 'sharp'

interface Size {
    height: number;
    width: number;
}

export default class FrameImageProcesser {
    private readonly _image: sharp;
    private readonly _size: Size

    constructor({ buffer, size } : { buffer: Buffer, size: Size}) {
        this._image = sharp(buffer)
        this._size = size
    }

    public async process(options: { width: number, height: number, backgroundColor: string }): Promise<Buffer> {
      const {width, height} = this._size

      if (width && height){
        this._image.resize({ width, height })
      }
      
      this._image.extract({top:0, left:0, height: Math.min(options.height, height), width: Math.min(options.width, width)})
        .extend({
          top: 0,
          bottom: Math.max(options.height - height,0),
          left: 0,
          right: Math.max(options.width - width ,0),
          background: options.backgroundColor
        })
        
        return await  this._image.toFormat('jpeg').toBuffer();
      }
}