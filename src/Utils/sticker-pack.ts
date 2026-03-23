import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { zipSync } from 'fflate'
import { promises as fs } from 'fs'
import { gunzipSync, gzipSync } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { MediaType } from '../Defaults/index.js'
import type { StickerPack, WAMediaUpload, WAMediaUploadFunction } from '../Types/Message.js'
import { generateMessageIDV2 } from './generics.js'
import type { ILogger } from './logger.js'
import { encryptedStream, getImageProcessingLibrary } from './messages-media.js'

/**
 * Verifica se um buffer é um arquivo WebP válido
 * Valida os magic bytes: RIFF....WEBP
 */
export const isWebPBuffer = (buffer: Buffer): boolean => {
	if (buffer.length < 12) return false

	const riffHeader = buffer.toString('ascii', 0, 4)
	const webpHeader = buffer.toString('ascii', 8, 12)

	return riffHeader === 'RIFF' && webpHeader === 'WEBP'
}

/**
 * Detecta se um WebP é animado através da análise de chunks
 */
export const isAnimatedWebP = (buffer: Buffer): boolean => {
	if (!isWebPBuffer(buffer)) return false

	const MAX_CHUNK_SIZE = 100 * 1024 * 1024
	const MAX_ITERATIONS = 1000

	let offset = 12
	let iterations = 0

	while (offset < buffer.length - 8 && iterations++ < MAX_ITERATIONS) {
		const chunkFourCC = buffer.toString('ascii', offset, offset + 4)
		const chunkSize = buffer.readUInt32LE(offset + 4)

		if (chunkSize < 0 || chunkSize > MAX_CHUNK_SIZE) return false
		if (offset + 8 + chunkSize > buffer.length) return false

		if (chunkFourCC === 'VP8X' && offset + 8 < buffer.length) {
			const flags = buffer[offset + 8]
			if (flags && flags & 0x02) return true
		}

		if (chunkFourCC === 'ANIM' || chunkFourCC === 'ANMF') return true

		offset += 8 + chunkSize + (chunkSize % 2)
	}

	return false
}

/**
 * Detecta se um buffer é Lottie JSON (raw ou gzip-compressed/WAS)
 */
export const isLottieBuffer = (buffer: Buffer): boolean => {
	if (buffer.length < 2) return false

	let jsonBuffer: Buffer

	if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
		try {
			jsonBuffer = gunzipSync(buffer, { maxOutputLength: 50 * 1024 * 1024 })
		} catch {
			return false
		}
	} else if (buffer[0] === 0x7b) {
		jsonBuffer = buffer
	} else {
		return false
	}

	try {
		const str = jsonBuffer.toString('utf8', 0, Math.min(jsonBuffer.length, 4096))
		return str.includes('"v"') && str.includes('"layers"') && str.includes('"ip"') && str.includes('"op"')
	} catch {
		return false
	}
}

/**
 * Converte uma imagem para WebP usando Sharp
 */
const convertToWebP = async (
	buffer: Buffer,
	logger?: ILogger
): Promise<{ webpBuffer: Buffer; isAnimated: boolean; isLottie: boolean }> => {
	if (isLottieBuffer(buffer)) {
		let wasBuffer = buffer
		if (buffer[0] === 0x7b) {
			logger?.trace('Raw Lottie JSON detected, gzip-compressing to WAS format')
			wasBuffer = gzipSync(buffer)
		}

		logger?.trace('Input is Lottie/WAS format')
		return { webpBuffer: wasBuffer, isAnimated: true, isLottie: true }
	}

	if (isWebPBuffer(buffer)) {
		const isAnimated = isAnimatedWebP(buffer)
		logger?.trace({ isAnimated }, 'Input is already WebP, preserving original buffer')
		return { webpBuffer: buffer, isAnimated, isLottie: false }
	}

	const lib = await getImageProcessingLibrary()

	if (!lib?.sharp) {
		throw new Boom(
			'Sharp library is required to convert non-WebP images to WebP format. Install with: yarn add sharp',
			{ statusCode: 400 }
		)
	}

	logger?.trace('Converting image to WebP using Sharp')
	const webpBuffer = await lib.sharp.default(buffer).webp().toBuffer()

	return { webpBuffer, isAnimated: false, isLottie: false }
}

/**
 * Gera hash SHA256 em formato base64 URL-safe (RFC 4648)
 */
const generateSha256Hash = (buffer: Buffer): string => {
	return createHash('sha256').update(buffer).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Converte WAMediaUpload para Buffer com limites de segurança
 */
const mediaToBuffer = async (
	media: WAMediaUpload,
	context: string,
	options?: { maxSize?: number; timeout?: number }
): Promise<Buffer> => {
	const MAX_SIZE = options?.maxSize || 10 * 1024 * 1024
	const TIMEOUT = options?.timeout || 30000

	if (Buffer.isBuffer(media)) {
		if (media.length > MAX_SIZE) {
			throw new Boom(`${context} size (${(media.length / 1024).toFixed(2)}KB) exceeds ${MAX_SIZE / 1024}KB limit`, {
				statusCode: 413
			})
		}

		return media
	} else if (typeof media === 'object' && 'url' in media) {
		const url = media.url.toString()

		if (url.startsWith('data:')) {
			try {
				const base64Data = url.split(',')[1]
				if (!base64Data) {
					throw new Boom(`Invalid data URL for ${context}: missing base64 data`, { statusCode: 400 })
				}

				const buffer = Buffer.from(base64Data, 'base64')

				if (buffer.length > MAX_SIZE) {
					throw new Boom(
						`${context} data URL size (${(buffer.length / 1024).toFixed(2)}KB) exceeds ${MAX_SIZE / 1024}KB limit`,
						{ statusCode: 413 }
					)
				}

				return buffer
			} catch (error) {
				if (error instanceof Boom) throw error
				throw new Boom(`Failed to parse data URL for ${context}: ${(error as Error).message}`, {
					statusCode: 400
				})
			}
		}

		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUT)

		try {
			const response = await fetch(url, { signal: controller.signal })

			if (!response.ok) {
				throw new Boom(`Failed to download ${context} from URL: ${url}`, {
					statusCode: 400,
					data: { url, status: response.status }
				})
			}

			const contentLength = response.headers.get('content-length')
			if (contentLength && parseInt(contentLength) > MAX_SIZE) {
				throw new Boom(
					`${context} URL file size (${(parseInt(contentLength) / 1024).toFixed(2)}KB) exceeds ${MAX_SIZE / 1024}KB limit`,
					{ statusCode: 413, data: { url, contentLength } }
				)
			}

			const chunks: Buffer[] = []
			let totalSize = 0

			if (!response.body) {
				throw new Boom(`${context} URL response has no body`, { statusCode: 400, data: { url } })
			}

			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				const buffer = Buffer.from(chunk)
				totalSize += buffer.length

				if (totalSize > MAX_SIZE) {
					throw new Boom(
						`${context} download (${(totalSize / 1024).toFixed(2)}KB) exceeded ${MAX_SIZE / 1024}KB limit`,
						{ statusCode: 413, data: { url } }
					)
				}

				chunks.push(buffer)
			}

			return Buffer.concat(chunks)
		} finally {
			clearTimeout(timeoutId)
		}
	} else if (typeof media === 'object' && 'stream' in media) {
		const chunks: Buffer[] = []
		let totalSize = 0

		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Boom(`${context} stream timeout after ${TIMEOUT}ms`, { statusCode: 408 })), TIMEOUT)
		)

		try {
			await Promise.race([
				(async () => {
					for await (const chunk of media.stream) {
						const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
						totalSize += buffer.length

						if (totalSize > MAX_SIZE) {
							throw new Boom(
								`${context} stream size (${(totalSize / 1024).toFixed(2)}KB) exceeds ${MAX_SIZE / 1024}KB limit`,
								{ statusCode: 413 }
							)
						}

						chunks.push(buffer)
					}
				})(),
				timeoutPromise
			])

			return Buffer.concat(chunks)
		} catch (error) {
			media.stream.destroy()
			throw error
		}
	} else {
		throw new Boom(`Invalid ${context} data format`, { statusCode: 400 })
	}
}

export type PrepareStickerPackMessageOptions = {
	upload: WAMediaUploadFunction
	logger?: ILogger
	mediaUploadTimeoutMs?: number
}

/**
 * Prepara uma mensagem de sticker pack para envio
 */
export const prepareStickerPackMessage = async (
	stickerPack: StickerPack,
	options: PrepareStickerPackMessageOptions
): Promise<proto.Message.StickerPackMessage> => {
	const { upload, logger, mediaUploadTimeoutMs } = options
	const { stickers, cover, name, publisher, description, packId } = stickerPack

	// Helper: Upload Media
	const uploadMedia = async (buffer: Buffer, mediaType: MediaType, opts?: { mediaKey?: Uint8Array }) => {
		let encFilePath: string | undefined

		try {
			const encrypted = await encryptedStream(buffer, mediaType, {
				logger,
				mediaKey: opts?.mediaKey
			})

			encFilePath = encrypted.encFilePath

			const result = await upload(encrypted.encFilePath, {
				fileEncSha256B64: encrypted.fileEncSha256.toString('base64'),
				mediaType,
				timeoutMs: mediaUploadTimeoutMs
			})

			return {
				mediaKey: encrypted.mediaKey,
				fileSha256: encrypted.fileSha256,
				fileEncSha256: encrypted.fileEncSha256,
				directPath: result.directPath,
				mediaKeyTimestamp: result.ts
			}
		} finally {
			if (encFilePath) {
				try {
					await fs.unlink(encFilePath)
					logger?.trace({ encFilePath }, 'Cleaned up temporary encrypted file')
				} catch (unlinkError) {
					logger?.warn({ encFilePath, error: unlinkError }, 'Failed to cleanup temp file')
				}
			}
		}
	}

	// Helper: Compress Sticker logic extracted to avoid max-depth eslint error
	const attemptCompression = async (buffer: Buffer, index: number): Promise<Buffer> => {
		const MAX_SIZE = 1024 * 1024
		const lib = await getImageProcessingLibrary()

		if (!lib?.sharp) {
			throw new Boom(
				`Sticker ${index + 1} exceeds the 1MB hard limit (${(buffer.length / 1024).toFixed(2)}KB). ` +
					`Sharp library required for auto-compression. Install with: yarn add sharp`,
				{ statusCode: 400 }
			)
		}

		try {
			const compressed70 = await lib.sharp.default(buffer).webp({ quality: 70 }).toBuffer()
			if (compressed70.length <= MAX_SIZE) {
				logger?.info(
					{
						index,
						originalKB: (buffer.length / 1024).toFixed(2),
						compressedKB: (compressed70.length / 1024).toFixed(2)
					},
					`Sticker ${index + 1} compressed successfully (quality 70)`
				)
				return compressed70
			}

			const compressed50 = await lib.sharp.default(buffer).webp({ quality: 50 }).toBuffer()
			if (compressed50.length <= MAX_SIZE) {
				logger?.info(
					{
						index,
						originalKB: (buffer.length / 1024).toFixed(2),
						compressedKB: (compressed50.length / 1024).toFixed(2)
					},
					`Sticker ${index + 1} compressed successfully (quality 50)`
				)
				return compressed50
			}

			throw new Boom(`Sticker ${index + 1} still exceeds 1MB after compression. Please use a smaller image.`, {
				statusCode: 400
			})
		} catch (error) {
			if (error instanceof Boom) throw error
			throw new Boom(`Sticker ${index + 1} exceeds 1MB and compression failed: ${(error as Error).message}`, {
				statusCode: 400
			})
		}
	}

	// 1. Validações
	const validStickers = stickers.filter((s): s is NonNullable<typeof s> => s !== null && s !== undefined)

	if (validStickers.length < 3 || validStickers.length > 30) {
		throw new Boom(
			`Sticker pack must contain between 3 and 30 valid stickers per WhatsApp official spec. ` +
				`Provided: ${validStickers.length} valid stickers ` +
				`(${stickers.length} total, ${stickers.length - validStickers.length} invalid/undefined)`,
			{ statusCode: 400 }
		)
	}

	if (name.length > 128) {
		throw new Boom(`Pack name must be 128 characters or less. Current length: ${name.length}`, {
			statusCode: 400
		})
	}

	if (publisher.length > 128) {
		throw new Boom(`Publisher name must be 128 characters or less. Current length: ${publisher.length}`, {
			statusCode: 400
		})
	}

	logger?.info({ stickerCount: stickers.length, name, publisher }, 'Preparing sticker pack message')

	// 2. Gera ID
	const stickerPackId = packId || generateMessageIDV2()

	// 3. Processa stickers
	const stickerData: Record<string, [Uint8Array, { level: 0 }]> = {}
	const stickerMetadata: proto.Message.StickerPackMessage.ISticker[] = []
	const metadataByHash = new Map<string, proto.Message.StickerPackMessage.ISticker>()

	const processedStickers = await Promise.all(
		stickers.map(async (sticker, i) => {
			if (!sticker) return null

			try {
				logger?.trace({ index: i }, 'Processing sticker')

				const buffer = await mediaToBuffer(sticker.data, `sticker ${i + 1}`)
				const converted = await convertToWebP(buffer, logger)

				let webpBuffer = converted.webpBuffer
				const { isAnimated, isLottie } = converted

				if (sticker.isLottie !== undefined && sticker.isLottie !== isLottie) {
					throw new Boom(
						`Sticker ${i + 1}: explicit isLottie=${sticker.isLottie} does not match detected format (detected=${isLottie})`,
						{ statusCode: 400 }
					)
				}

				if (!isLottie && isWebPBuffer(webpBuffer)) {
					const lib = await getImageProcessingLibrary()
					if (lib?.sharp) {
						const metadata = await lib.sharp.default(webpBuffer).metadata()
						if (metadata.width !== 512 || metadata.height !== 512) {
							logger?.trace(
								{ index: i, width: metadata.width, height: metadata.height },
								'Resizing sticker to 512x512 (WABA standard)'
							)
							webpBuffer = await lib.sharp
								.default(webpBuffer)
								.resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
								.webp()
								.toBuffer()
						}
					}
				}

				const MAX_STICKER_SIZE = 1024 * 1024 // 1MB
				const recommendedLimit = isAnimated ? 500 : 100

				if (webpBuffer.length > MAX_STICKER_SIZE) {
					logger?.warn(
						{ index: i, sizeKB: (webpBuffer.length / 1024).toFixed(2) },
						`Sticker ${i + 1} exceeds 1MB, attempting compression...`
					)
					// Fungsi kompresi dipanggil di sini agar tidak memicu error max-depth eslint
					webpBuffer = await attemptCompression(webpBuffer, i)
				}

				const finalSizeKB = webpBuffer.length / 1024
				if (finalSizeKB > recommendedLimit) {
					logger?.warn(
						{ index: i, sizeKB: finalSizeKB, recommendedLimit, isAnimated },
						`Sticker ${i + 1} exceeds WhatsApp recommended size (${recommendedLimit}KB). ` +
							`This may cause slower sending or delivery issues.`
					)
				}

				const sha256Hash = generateSha256Hash(webpBuffer)
				const extension = isLottie ? 'was' : 'webp'
				const fileName = `${sha256Hash}.${extension}`

				logger?.trace(
					{ index: i, fileName, sizeKB: finalSizeKB.toFixed(2), isAnimated, isLottie },
					'Sticker processed successfully'
				)

				return {
					fileName,
					webpBuffer,
					isAnimated,
					isLottie,
					emojis: sticker.emojis || [],
					accessibilityLabel: sticker.accessibilityLabel
				}
			} catch (error) {
				throw new Boom(`Failed to process sticker ${i + 1}: ${(error as Error).message}`, {
					statusCode: error instanceof Boom ? error.output.statusCode : 500,
					data: { stickerIndex: i, originalError: error }
				})
			}
		})
	)

	let duplicateCount = 0
	for (const result of processedStickers) {
		if (!result) continue

		const { fileName, webpBuffer, isAnimated, isLottie, emojis, accessibilityLabel } = result
		const existingMetadata = metadataByHash.get(fileName)

		if (existingMetadata) {
			duplicateCount++
			const mergedEmojis = Array.from(new Set([...existingMetadata.emojis!, ...emojis]))
			existingMetadata.emojis = mergedEmojis

			if (accessibilityLabel) {
				if (existingMetadata.accessibilityLabel) {
					existingMetadata.accessibilityLabel += ` / ${accessibilityLabel}`
				} else {
					existingMetadata.accessibilityLabel = accessibilityLabel
				}
			}

			logger?.debug({ fileName, mergedEmojis, duplicateCount }, 'Duplicate sticker detected - merged metadata')
		} else {
			stickerData[fileName] = [new Uint8Array(webpBuffer), { level: 0 as 0 }]
			const metadata: proto.Message.StickerPackMessage.ISticker = {
				fileName,
				isAnimated,
				emojis,
				accessibilityLabel,
				isLottie,
				mimetype: isLottie ? 'application/was' : 'image/webp'
			}

			metadataByHash.set(fileName, metadata)
			stickerMetadata.push(metadata)
		}
	}

	if (duplicateCount > 0) {
		logger?.info(
			{ duplicateCount, uniqueStickers: stickerMetadata.length },
			`Removed ${duplicateCount} duplicate stickers via deduplication`
		)
	}

	// 4. Processa cover image (tray icon)
	let coverBuffer: Buffer
	let coverWebP: Buffer
	let coverFileName: string

	try {
		logger?.trace('Processing cover image')
		coverBuffer = await mediaToBuffer(cover, 'cover image')

		const lib = await getImageProcessingLibrary()
		if (!lib?.sharp) {
			throw new Boom('Sharp library is required for cover/tray icon processing. Install with: yarn add sharp', {
				statusCode: 400
			})
		}

		coverWebP = await lib.sharp
			.default(coverBuffer)
			.resize(96, 96, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png()
			.toBuffer()

		coverFileName = `${stickerPackId}.png`
		stickerData[coverFileName] = [new Uint8Array(coverWebP), { level: 0 as 0 }]
	} catch (error) {
		throw new Boom(`Failed to process cover image: ${(error as Error).message}`, {
			statusCode: error instanceof Boom ? error.output.statusCode : 500,
			data: { originalError: error }
		})
	}

	// 5. Cria ZIP
	let zipBuffer: Buffer
	let uniqueFiles: number

	try {
		uniqueFiles = Object.keys(stickerData).length
		logger?.trace({ totalFiles: uniqueFiles, includingCover: true }, 'Creating ZIP file')

		zipBuffer = Buffer.from(zipSync(stickerData))

		logger?.info({ zipSizeKB: (zipBuffer.length / 1024).toFixed(2) }, 'ZIP file created successfully')

		const MAX_PACK_SIZE = 30 * 1024 * 1024
		if (zipBuffer.length > MAX_PACK_SIZE) {
			throw new Boom(
				`Total pack size exceeds ${MAX_PACK_SIZE / 1024 / 1024}MB limit. ` +
					`Current size: ${(zipBuffer.length / 1024 / 1024).toFixed(2)}MB. ` +
					`Try compressing stickers or reducing pack size.`,
				{ statusCode: 400 }
			)
		}
	} catch (error) {
		throw new Boom(`Failed to create ZIP archive: ${(error as Error).message}`, {
			statusCode: error instanceof Boom ? error.output.statusCode : 500,
			data: { originalError: error }
		})
	}

	// 6. Upload do ZIP criptografado
	let stickerPackUpload: Awaited<ReturnType<typeof uploadMedia>>

	try {
		logger?.trace('Uploading encrypted sticker pack ZIP')
		stickerPackUpload = await uploadMedia(zipBuffer, 'sticker-pack')
	} catch (error) {
		throw new Boom(`Failed to upload sticker pack: ${(error as Error).message}`, {
			statusCode: error instanceof Boom ? error.output.statusCode : 500,
			data: { originalError: error }
		})
	}

	// 7. Gera thumbnail 252x252 JPEG
	let thumbnailBuffer: Buffer

	try {
		logger?.trace('Generating thumbnail (252x252 JPEG)')
		const lib = await getImageProcessingLibrary()

		if (!lib?.sharp) {
			throw new Boom('Sharp library is required for thumbnail generation. Install with: yarn add sharp', {
				statusCode: 400
			})
		}

		thumbnailBuffer = await lib.sharp
			.default(coverBuffer)
			.resize(252, 252, { fit: 'cover', position: 'center' })
			.jpeg({ quality: 85 })
			.toBuffer()

		logger?.trace({ thumbnailSizeKB: (thumbnailBuffer.length / 1024).toFixed(2) }, 'Thumbnail generated')
	} catch (error) {
		throw new Boom(`Failed to generate thumbnail: ${(error as Error).message}`, {
			statusCode: error instanceof Boom ? error.output.statusCode : 500,
			data: { originalError: error }
		})
	}

	// 8. Upload do thumbnail
	let thumbUpload: Awaited<ReturnType<typeof uploadMedia>>

	try {
		logger?.trace('Uploading thumbnail with same mediaKey')
		thumbUpload = await uploadMedia(thumbnailBuffer, 'thumbnail-sticker-pack', {
			mediaKey: stickerPackUpload.mediaKey
		})
	} catch (error) {
		throw new Boom(`Failed to upload thumbnail: ${(error as Error).message}`, {
			statusCode: error instanceof Boom ? error.output.statusCode : 500,
			data: { originalError: error }
		})
	}

	// 9. Monta mensagem protobuf
	logger?.info(
		{
			packId: stickerPackId,
			totalStickers: stickers.length,
			uniqueFiles: uniqueFiles - 1,
			zipSizeKB: (zipBuffer.length / 1024).toFixed(2)
		},
		'Sticker pack message prepared successfully'
	)

	return proto.Message.StickerPackMessage.create({
		stickerPackId,
		name,
		publisher,
		packDescription: description,
		stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
		stickerPackSize: zipBuffer.length,
		stickers: stickerMetadata,
		fileSha256: stickerPackUpload.fileSha256,
		fileEncSha256: stickerPackUpload.fileEncSha256,
		mediaKey: stickerPackUpload.mediaKey,
		directPath: stickerPackUpload.directPath,
		fileLength: zipBuffer.length,
		mediaKeyTimestamp: stickerPackUpload.mediaKeyTimestamp,
		trayIconFileName: coverFileName,
		thumbnailDirectPath: thumbUpload.directPath,
		thumbnailSha256: createHash('sha256').update(thumbnailBuffer).digest(),
		thumbnailEncSha256: thumbUpload.fileEncSha256,
		thumbnailHeight: 252,
		thumbnailWidth: 252,
		imageDataHash: createHash('sha256').update(thumbnailBuffer).digest('base64')
	})
}
