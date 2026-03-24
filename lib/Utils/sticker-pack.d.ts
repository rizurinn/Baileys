import { proto } from '../../WAProto/index.js';
import type { StickerPack, WAMediaUploadFunction } from '../Types/Message.js';
import type { ILogger } from './logger.js';
/**
 * Verifica se um buffer é um arquivo WebP válido
 * Valida os magic bytes: RIFF....WEBP
 */
export declare const isWebPBuffer: (buffer: Buffer) => boolean;
/**
 * Detecta se um WebP é animado através da análise de chunks
 */
export declare const isAnimatedWebP: (buffer: Buffer) => boolean;
/**
 * Detecta se um buffer é Lottie JSON (raw ou gzip-compressed/WAS)
 */
export declare const isLottieBuffer: (buffer: Buffer) => boolean;
export type PrepareStickerPackMessageOptions = {
    upload: WAMediaUploadFunction;
    logger?: ILogger;
    mediaUploadTimeoutMs?: number;
};
/**
 * Prepara uma mensagem de sticker pack para envio
 */
export declare const prepareStickerPackMessage: (stickerPack: StickerPack, options: PrepareStickerPackMessageOptions) => Promise<proto.Message.StickerPackMessage>;
//# sourceMappingURL=sticker-pack.d.ts.map