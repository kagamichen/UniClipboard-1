import { image } from '@kit.ImageKit';

export interface ImageMemoryLimits {
  maxEncodedBytes: number;
  maxPixels: number;
}

export class ImageClipboardCodec {
  private readonly maxEncodedBytes: number;
  private readonly maxPixels: number;

  constructor(limits: ImageMemoryLimits) {
    if (!Number.isSafeInteger(limits.maxEncodedBytes) || limits.maxEncodedBytes <= 0 ||
      !Number.isSafeInteger(limits.maxPixels) || limits.maxPixels <= 0) {
      throw new Error('OHOS_IMAGE_INVALID_LIMIT');
    }
    this.maxEncodedBytes = limits.maxEncodedBytes;
    this.maxPixels = limits.maxPixels;
  }

  /**
   * The caller retains ownership of the source PixelMap until encoding settles.
   * @throws {Error} Rejects if encoding, memory limits, or resource cleanup fails.
   */
  async encodePng(pixelMap: image.PixelMap): Promise<Uint8Array> {
    this.checkSize((await pixelMap.getImageInfo()).size);
    const packer = image.createImagePacker();
    if (packer === null || packer === undefined) {
      throw new Error('OHOS_IMAGE_UNAVAILABLE');
    }
    try {
      const data = await packer.packToData(pixelMap, {
        format: 'image/png', quality: 100, bufferSize: this.maxEncodedBytes,
        needsPackProperties: false
      });
      this.checkEncodedSize(data.byteLength);
      return new Uint8Array(data);
    } finally {
      await packer.release();
    }
  }

  /**
   * The decoded PixelMap is borrowed by consume and must not outlive its promise.
   * @throws {Error} Rejects if decoding, consumption, memory limits, or cleanup fails.
   */
  async withDecodedImage(bytes: Uint8Array, consume: (pixelMap: image.PixelMap) => Promise<void>): Promise<void> {
    this.checkEncodedSize(bytes.byteLength);
    const copy = new Uint8Array(bytes);
    try {
      const source = image.createImageSource(copy.buffer as ArrayBuffer);
      if (source === null || source === undefined) {
        throw new Error('OHOS_IMAGE_UNAVAILABLE');
      }
      try {
        this.checkSize((await source.getImageInfo()).size);
        const pixelMap = await source.createPixelMap({ desiredPixelFormat: image.PixelMapFormat.RGBA_8888 });
        try {
          this.checkSize((await pixelMap.getImageInfo()).size);
          await consume(pixelMap);
        } finally {
          await pixelMap.release();
        }
      } finally {
        await source.release();
      }
    } finally {
      copy.fill(0);
    }
  }

  private checkEncodedSize(size: number): void {
    if (size <= 0 || size > this.maxEncodedBytes) {
      throw new Error('OHOS_IMAGE_SIZE_LIMIT');
    }
  }

  private checkSize(size: image.Size): void {
    if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) ||
      size.width <= 0 || size.height <= 0 || size.width > this.maxPixels / size.height) {
      throw new Error('OHOS_IMAGE_PIXEL_LIMIT');
    }
  }
}
