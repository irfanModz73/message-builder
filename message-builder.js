ok bro ubahin dong ni message builder dri client jdi conn biar sesuai sama bailesy gw pake sama kirim fullcode tanpa hapus/kurangin code asli
'use strict';

const VERSION = '5.2';

import { generateWAMessageFromContent, prepareWAMessageMedia, generateMessageIDV2 } from 'baileys';
import crypto from 'crypto';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough, Readable } from 'stream';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

function extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
	if (!extract) {
		return {
			text,
			ie: [],
			inline_entities: [],
		};
	}

	const createIE = (type, ie) => {
		if (type == 'hyperlink') {
			return {
				key: ie.key,
				metadata: {
					display_name: ie.text,
					is_trusted: ie.is_trusted,
					url: ie.url,
					__typename: 'GenAIInlineLinkItem',
				},
			};
		}

		if (type == 'citation') {
			return {
				key: ie.key,
				metadata: {
					reference_id: ie.reference_id,
					reference_url: ie.url,
					reference_title: ie.url,
					reference_display_name: ie.url,
					sources: [],
					__typename: 'GenAISearchCitationItem',
				},
			};
		}

		if (type == 'latex') {
			return {
				key: ie.key,
				metadata: {
					latex_expression: ie.text,
					latex_image: {
						url: ie.url,
						width: Number(ie.width) || 100,
						height: Number(ie.height) || 100,
					},
					font_height: Number(ie.font_height) || 83.333333333333,
					padding: Number(ie.padding) || 15,
					__typename: 'GenAILatexItem',
				},
			};
		}
	};

	let ie = [];
	let inline_entities = [];
	let result = '';
	let last = 0;
	let citation_index = 1;
	let hyperlink_index = 0;
	let latex_index = 0;
	let stack = [];

	for (let i = 0; i < text.length; i++) {
		if (text[i] == '[' && text[i - 1] != '\\') {
			stack.push(i);
		} else if (text[i] == ']' && (text[i + 1] == '(' || text[i + 1] == '<')) {
			let start = stack.pop();

			if (start == null) continue;

			let open = text[i + 1];
			let close = open == '(' ? ')' : '>';
			let type = open == '(' ? 'link' : 'latex';
			let end = i + 2;
			let depth = 1;

			while (end < text.length && depth) {
				if (text[end] == open && text[end - 1] != '\\') depth++;
				else if (text[end] == close && text[end - 1] != '\\') depth--;
				end++;
			}

			if (depth) continue;

			let raw = text.slice(start + 1, i).trim();
			let url = text.slice(i + 2, end - 1).trim();

			let key;
			let tag;
			let data;

			if (type == 'latex') {
				if (!latex) continue;

				let [txt = '', width = null, height = null, font_height = null, padding = null] = raw.split('|');

				key = `\u004E\u0049\u0058\u0045\u004C_LATEX_${latex_index++}`;
				tag = `{{${key}}}${txt || 'image'}{{/${key}}}`;

				data = {
					type: 'latex',
					ie: {
						key,
						text: txt,
						url,
						width,
						height,
						font_height,
						padding,
					},
				};
			} else if (raw) {
				if (!hyperlink) continue;

				const trusted = !url.startsWith('!');

				if (!trusted) {
					url = url.slice(1);
				}

				key = `\u004E\u0049\u0058\u0045\u004C_HYPERLINK_${hyperlink_index++}`;
				tag = `{{${key}}}${url}{{/${key}}}`;

				data = {
					type: 'hyperlink',
					ie: {
						key,
						text: raw,
						url,
						is_trusted: trusted,
					},
				};
			} else {
				if (!citation) continue;

				key = `\u004E\u0049\u0058\u0045\u004C_CITATION_${citation_index - 1}`;
				tag = `{{${key}}}${url}{{/${key}}}`;

				data = {
					type: 'citation',
					ie: {
						reference_id: citation_index++,
						key,
						text: '',
						url,
					},
				};
			}

			result += text.slice(last, start) + tag;
			last = end;

			ie.push(data);

			const entity = createIE(data.type, data.ie);

			if (entity) {
				inline_entities.push(entity);
			}

			i = end - 1;
		}
	}

	result += text.slice(last);

	return {
		text: result,
		ie,
		inline_entities,
	};
}

async function waitAllPromises(input) {
	const isPromise = (v) => v && typeof v.then === 'function';
	const isObject = (v) => v && typeof v === 'object';

	const deep = async (v) => {
		if (isPromise(v)) return deep(await v);
		if (Array.isArray(v)) return Promise.all(v.map(deep));
		if (isObject(v)) {
			const entries = await Promise.all(Object.entries(v).map(async ([k, val]) => [k, await deep(val)]));
			return Object.fromEntries(entries);
		}
		return v;
	};

	return deep(await input);
}

function resolveAIRichSource(client, source, mediaType = 'image') {
	if (Buffer.isBuffer(source)) {
		if (!source.length) throw new Error('Media buffer is empty');
		return Toolkit.resolveMedia(client, source, mediaType);
	}

	if (typeof source !== 'string' || !source.trim()) {
		throw new TypeError('Media source must be a URL, file path, or Buffer');
	}

	if (/^https?:\/\//i.test(source)) {
		return Toolkit.resolveMedia(client, source, mediaType);
	}

	const buffer = readFileSync(source);
	if (!buffer.length) throw new Error(`Media file is empty: ${source}`);

	return Toolkit.resolveMedia(client, buffer, mediaType);
}

function inferAudioMime(source, fallback = 'audio/mpeg') {
	if (typeof source !== 'string') return fallback;

	let pathname = source;

	try {
		if (/^https?:\/\//i.test(source)) {
			pathname = new URL(source).pathname;
		}
	} catch {}

	const ext = extname(pathname).toLowerCase();

	return (
		{
			'.mp3': 'audio/mpeg',
			'.m4a': 'audio/mp4',
			'.aac': 'audio/aac',
			'.ogg': 'audio/ogg; codecs=opus',
			'.opus': 'audio/ogg; codecs=opus',
			'.wav': 'audio/wav',
			'.flac': 'audio/flac',
			'.mp4': 'audio/mp4',
		}[ext] || fallback
	);
}

function inferImageMime(source, fallback = 'image/jpeg') {
	if (typeof source !== 'string') return fallback;

	let pathname = source;

	try {
		if (/^https?:\/\//i.test(source)) {
			pathname = new URL(source).pathname;
		}
	} catch {}

	const ext = extname(pathname).toLowerCase();

	return (
		{
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.png': 'image/png',
			'.webp': 'image/webp',
			'.gif': 'image/gif',
			'.bmp': 'image/bmp',
			'.svg': 'image/svg+xml',
			'.tiff': 'image/tiff',
			'.avif': 'image/avif',
		}[ext] || fallback
	);
}

function inferVideoMime(source, fallback = 'video/mp4') {
	if (typeof source !== 'string') return fallback;

	let pathname = source;

	try {
		if (/^https?:\/\//i.test(source)) {
			pathname = new URL(source).pathname;
		}
	} catch {}

	const ext = extname(pathname).toLowerCase();

	return (
		{
			'.mp4': 'video/mp4',
			'.m4v': 'video/mp4',
			'.webm': 'video/webm',
			'.mkv': 'video/x-matroska',
			'.mov': 'video/quicktime',
			'.avi': 'video/x-msvideo',
			'.3gp': 'video/3gpp',
			'.ogv': 'video/ogg',
		}[ext] || fallback
	);
}

class AIRichError extends Error {
	constructor(message, code, meta = {}) {
		super(message);
		this.name = 'AIRichError';
		this.code = code;
		Object.assign(this, meta);
	}
}

class ItemNotFoundError extends AIRichError {
	constructor(id, availableIds = []) {
		super(`Item id "${id}" not found${availableIds.length ? ` (available: ${availableIds.join(', ')})` : ' (no items have an id yet)'}`, 'ITEM_NOT_FOUND', { id, availableIds });
		this.name = 'ItemNotFoundError';
	}
}

class DuplicateIdError extends AIRichError {
	constructor(id) {
		super(`Item id "${id}" already exists`, 'DUPLICATE_ID', { id });
		this.name = 'DuplicateIdError';
	}
}

class InvalidTargetError extends AIRichError {
	constructor(message, meta = {}) {
		super(message, 'INVALID_TARGET', meta);
		this.name = 'InvalidTargetError';
	}
}

class ContentValidationError extends AIRichError {
	constructor(message, meta = {}) {
		super(message, 'CONTENT_VALIDATION', meta);
		this.name = 'ContentValidationError';
	}
}

class Toolkit {
	constructor() {}

	static extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
		return extractIE(text, { extract, hyperlink, citation, latex });
	}

	static async resize(buffer, x, y, fit = 'cover') {
		return await sharp(buffer)
			.resize(x, y, {
				fit,
				position: 'center',
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			})
			.png()
			.toBuffer();
	}

	static async waitAllPromises(input) {
		return await waitAllPromises(input);
	}

	static async fetchBuffer(url, options = {}, { silent = true } = {}) {
		try {
			let response = await fetch(url, options);
			if (!response.ok) throw Error(`HTTP ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		} catch (error) {
			if (silent) return Buffer.alloc(0);
			throw error;
		}
	}

	static async toUrl(_client, path, mediaType = 'document') {
		if (!path) throw new Error('Url or buffer needed');

		const media = await prepareWAMessageMedia(
			{
				[mediaType]: Buffer.isBuffer(path) ? path : { url: path },
			},
			{
				upload: _client.waUploadToServer,
				jid: '\u0040\u006e\u0065\u0077\u0073\u006c\u0065\u0074\u0074\u0065\u0072',
			}
		);

		return Object.values(media)[0]?.url;
	}

	static resolveMedia(_client, media, mediaType = 'image', { resolveUrl = false, resolveWAUrl = false, result = 'url', resize = false, width = 300, height = 300 } = {}) {
		const isUrl = (str) => /^https?:\/\/.+/i.test(str);

		const isWAUrl = (str) => /^https?:\/\/[^/]*\.whatsapp\.net\//i.test(str);

		if (Array.isArray(media)) {
			return Promise.all(
				media.map((item) =>
					Toolkit.resolveMedia(_client, item, mediaType, {
						resolveUrl,
						resolveWAUrl,
						result,
						resize,
						width,
						height,
					})
				)
			);
		}

		const originalIsBuffer = Buffer.isBuffer(media);

		if (typeof media === 'string' && isUrl(media)) {
			if (isWAUrl(media)) {
				if (resolveWAUrl) {
					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				} else if (!resolveUrl) {
					if (result === 'url') return media;

					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				}
			} else {
				if (!resolveUrl) {
					if (result === 'url') return media;

					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				} else {
					media = await Toolkit.fetchBuffer(media, {}, { silent: true });
				}
			}
		}

		if (typeof media === 'string' && !isUrl(media)) {
			media = Buffer.from(media, 'base64');
		}

		if (!Buffer.isBuffer(media) || !media.length) {
			return;
		}

		if (resize && Buffer.isBuffer(media)) {
			media = await Toolkit.resize(media, width, height);
		}

		if (result === 'buffer') {
			return media;
		}

		if (result === 'base64') {
			return media.toString('base64');
		}

		if (originalIsBuffer) {
			return Toolkit.toUrl(_client, media, mediaType);
		}

		return Toolkit.toUrl(_client, media, mediaType);
	}

	static getMp4Duration(buffer, { silent = true } = {}) {
		try {
			if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
				if (silent) return 0;
				throw new Error('Invalid buffer');
			}

			let offset = 0;

			while (offset < buffer.length - 8) {
				const size = buffer.readUInt32BE(offset);

				if (size < 8 || offset + size > buffer.length) {
					if (silent) return 0;
					throw new Error('Invalid atom size');
				}

				const type = buffer.toString('ascii', offset + 4, offset + 8);

				if (type === 'moov') {
					let moovOffset = offset + 8;
					const moovEnd = offset + size;

					while (moovOffset < moovEnd - 8) {
						const childSize = buffer.readUInt32BE(moovOffset);

						if (childSize < 8 || moovOffset + childSize > moovEnd) {
							if (silent) return 0;
							throw new Error('Invalid child atom size');
						}

						const childType = buffer.toString('ascii', moovOffset + 4, moovOffset + 8);

						if (childType === 'mvhd') {
							const version = buffer.readUInt8(moovOffset + 8);

							if (version === 0) {
								const timescale = buffer.readUInt32BE(moovOffset + 20);
								const duration = buffer.readUInt32BE(moovOffset + 24);

								if (!timescale) {
									if (silent) return 0;
									throw new Error('Invalid timescale');
								}

								return duration / timescale;
							}

							if (version === 1) {
								const timescale = buffer.readUInt32BE(moovOffset + 32);
								const duration = Number(buffer.readBigUInt64BE(moovOffset + 36));

								if (!timescale) {
									if (silent) return 0;
									throw new Error('Invalid timescale');
								}

								return duration / timescale;
							}
						}

						moovOffset += childSize;
					}
				}

				offset += size;
			}

			if (silent) return 0;

			throw new Error('No mvhd found!');
		} catch (err) {
			if (silent) return 0;
			throw err;
		}
	}

	static getMp4Preview(videoBuffer, { time, result = 'buffer', resize = true, width = 300, height = 300, silent = true } = {}) {
		return new Promise((resolve, reject) => {
			const fail = (err) => {
				if (silent) {
					return resolve(result === 'base64' ? '' : Buffer.alloc(0));
				}
				return reject(err);
			};

			try {
				if (!Buffer.isBuffer(videoBuffer) || !videoBuffer.length) {
					return fail(new Error('videoBuffer tidak valid atau kosong'));
				}

				const inputStream = new Readable({ read() {} });
				inputStream.push(videoBuffer);
				inputStream.push(null);

				const outputStream = new PassThrough();
				const chunks = [];

				outputStream.on('data', (chunk) => chunks.push(chunk));

				outputStream.on('end', async () => {
					try {
						let output = Buffer.concat(chunks);

						if (!output.length) {
							return fail(new Error('Output kosong — cek format atau timestamp video'));
						}

						if (resize) {
							output = await Toolkit.resize(output, width, height);
						}

						return resolve(result === 'base64' ? output.toString('base64') : output);
					} catch (err) {
						return fail(err);
					}
				});

				outputStream.on('error', fail);

				time = time ?? Math.min(Toolkit.getMp4Duration(videoBuffer) * 0.2, 10);

				ffmpeg(inputStream)
					.outputOptions([`-ss ${time}`, '-vframes 1', '-vcodec png', '-f image2pipe'])
					.on('error', (err) => fail(new Error(`ffmpeg error: ${err.message}`)))
					.pipe(outputStream, { end: true });
			} catch (err) {
				return fail(err);
			}
		});
	}

	static stringifyEscaped(obj) {
		return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
	}

	static padRandom(base, targetLen) {
		if (base.length >= targetLen) return base.subarray(0, targetLen);
		return Buffer.concat([base, crypto.randomBytes(targetLen - base.length)]);
	}

	static truncate(text, max, suffix = '…') {
		if (typeof text !== 'string') return '';
		if (text.length <= max) return text;
		return text.slice(0, max - suffix.length) + suffix;
	}

	static resolveAIRichSource(client, source, mediaType = 'image') {
		return resolveAIRichSource(client, source, mediaType);
	}

	static inferAudioMime(source, fallback) {
		return inferAudioMime(source, fallback);
	}

	static inferImageMime(source, fallback) {
		return inferImageMime(source, fallback);
	}

	static inferVideoMime(source, fallback) {
		return inferVideoMime(source, fallback);
	}
}

class BaseBuilder {
	constructor() {
		this._title = '';
		this._subtitle = '';
		this._body = '';
		this._footer = '';
		this._contextInfo = {};
		this._extraPayload = {};
	}

	setTitle(title) {
		if (typeof title !== 'string') {
			throw new TypeError('Title must be a string');
		}
		this._title = title;
		return this;
	}

	setSubtitle(subtitle) {
		if (typeof subtitle !== 'string') {
			throw new TypeError('Subtitle must be a string');
		}
		this._subtitle = subtitle;
		return this;
	}

	setBody(body) {
		if (typeof body !== 'string') {
			throw new TypeError('Body must be a string');
		}
		this._body = body;
		return this;
	}

	setFooter(footer) {
		if (typeof footer !== 'string') {
			throw new TypeError('Footer must be a string');
		}
		this._footer = footer;
		return this;
	}

	setContextInfo(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('ContextInfo must be a plain object');
		}

		this._contextInfo = obj;
		return this;
	}

	addPayload(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Payload must be a plain object');
		}

		Object.assign(this._extraPayload, obj);

		return this;
	}
}

class Button extends BaseBuilder {
	#client;

	constructor(client) {
		super();
		if (!client) {
			throw new Error('Socket is required');
		}
		this.#client = client;

		this._buttons = [];
		this._data;
		this._currentSelectionIndex = -1;
		this._currentSectionIndex = -1;
		this._params = {};
		this._typing = undefined;
		this._api = undefined;
		this._poll = undefined;
		this._event = undefined;
		this._listData = undefined;
		this._currentListSection = -1;
		this._product = undefined;
		this._catalog = undefined;
	}

	loadFrom(msg) {
		if (!msg) throw new Error('interactiveMessage needed');
		if (!msg.interactiveMessage) throw new Error('interactiveMessage not found');

		const { interactiveMessage, ...extraPayload } = msg;
		const iM = interactiveMessage;
		const header = iM.header || {};
		const nativeFlow = iM.nativeFlowMessage || {};

		this._title = header.title || '';
		this._subtitle = header.subtitle || '';
		this._body = iM.body?.text || '';
		this._footer = iM.footer?.text || '';
		this._contextInfo = iM.contextInfo || {};
		this._extraPayload = extraPayload;

		this._buttons = Array.isArray(nativeFlow.buttons)
			? nativeFlow.buttons.map((button) => ({
					...button,
					buttonParamsJson: typeof button.buttonParamsJson === 'string' ? button.buttonParamsJson : JSON.stringify(button.buttonParamsJson || {}),
				}))
			: [];

		this._data = header.imageMessage
			? { imageMessage: header.imageMessage }
			: header.videoMessage
				? { videoMessage: header.videoMessage }
				: header.documentMessage
					? { documentMessage: header.documentMessage }
					: header.productMessage
						? { productMessage: header.productMessage }
						: undefined;

		this._params = {};

		if (typeof nativeFlow.messageParamsJson === 'string') {
			try {
				this._params = JSON.parse(nativeFlow.messageParamsJson || '{}');
			} catch {
				this._params = {};
			}
		} else if (nativeFlow.messageParamsJson && typeof nativeFlow.messageParamsJson === 'object') {
			this._params = { ...nativeFlow.messageParamsJson };
		}

		this._currentSelectionIndex = this._buttons.findLastIndex((button) => button.name === 'single_select');

		this._currentSectionIndex = -1;

		if (this._currentSelectionIndex !== -1) {
			try {
				const button = this._buttons[this._currentSelectionIndex];
				const params = JSON.parse(button.buttonParamsJson || '{}');

				if (Array.isArray(params.sections) && params.sections.length) {
					this._currentSectionIndex = params.sections.length - 1;
				}
			} catch {
				this._currentSelectionIndex = -1;
				this._currentSectionIndex = -1;
			}
		}

		return this;
	}

	setImage(path, options = {}) {
		if (!path) throw new Error('Url or buffer needed');
		Buffer.isBuffer(path) ? (this._data = { image: path, ...options }) : (this._data = { image: { url: path }, ...options });
		return this;
	}

	setDocument(path, options = {}) {
		if (!path) throw new Error('Url or buffer needed');
		Buffer.isBuffer(path) ? (this._data = { document: path, ...options }) : (this._data = { document: { url: path }, ...options });
		return this;
	}

	setMedia(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Media must be a plain object');
		}

		this._data = obj;
		return this;
	}

	clearButtons() {
		this._buttons = [];
		return this;
	}

	setParams(obj) {
		this._params = obj;
		return this;
	}

	addButton(name, params) {
		this._buttons.push({
			name,
			buttonParamsJson: typeof params === 'string' ? params : JSON.stringify(params),
		});

		return this;
	}

	makeRow(header = '', title = '', description = '', id = '') {
		if (this._currentSelectionIndex === -1 || this._currentSectionIndex === -1) {
			throw new Error('You need to create a selection and a section first');
		}
		const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
		buttonParams.sections[this._currentSectionIndex].rows.push({ header, title, description, id });
		this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
		return this;
	}

	makeSection(title = '', highlight_label = '') {
		if (this._currentSelectionIndex === -1) {
			throw new Error('You need to create a selection first');
		}
		const buttonParams = JSON.parse(this._buttons[this._currentSelectionIndex].buttonParamsJson);
		buttonParams.sections.push({ title, highlight_label, rows: [] });
		this._currentSectionIndex = buttonParams.sections.length - 1;
		this._buttons[this._currentSelectionIndex].buttonParamsJson = JSON.stringify(buttonParams);
		return this;
	}

	addSelection(title, options = {}) {
		this._buttons.push({ name: 'single_select', buttonParamsJson: JSON.stringify({ title, sections: [], ...options }) });
		this._currentSelectionIndex = this._buttons.length - 1;
		this._currentSectionIndex = -1;
		return this;
	}

	addReply(display_text = '', id = '', options = {}) {
		this._buttons.push({
			name: 'quick_reply',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addCall(display_text = '', id = '', options = {}) {
		this._buttons.push({
			name: 'cta_call',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addReminder(display_text = '', id = '', options = {}) {
		this._buttons.push({
			name: 'cta_reminder',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addCancelReminder(display_text = '', id = '', options = {}) {
		this._buttons.push({
			name: 'cta_cancel_reminder',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addAddress(display_text = '', id = '', options = {}) {
		this._buttons.push({
			name: 'address_message',
			buttonParamsJson: JSON.stringify({
				display_text,
				id,
				...options,
			}),
		});
		return this;
	}

	addLocation(options = {}) {
		this._buttons.push({
			name: 'send_location',
			buttonParamsJson: JSON.stringify(options),
		});
		return this;
	}

	addUrl(display_text = '', url = '', webview_interaction = false, options = {}) {
		this._buttons.push({
			...options,
			name: 'cta_url',
			buttonParamsJson: JSON.stringify({
				display_text,
				url,
				webview_interaction,
				...options,
			}),
		});
		return this;
	}

	addCopy(display_text = '', copy_code = '', options = {}) {
		this._buttons.push({
			name: 'cta_copy',
			buttonParamsJson: JSON.stringify({
				display_text,
				copy_code,
				...options,
			}),
		});
		return this;
	}

	addPoll(name, options = [], { selectableCount = 1, toAnnouncementGroup = false } = {}) {
		if (typeof name !== 'string') throw new TypeError('Poll name must be a string');
		if (!Array.isArray(options) || options.length < 2) {
			throw new TypeError('Poll requires at least 2 options');
		}

		this._poll = {
			name,
			options: options.map((o) => (typeof o === 'string' ? { optionName: o } : o)),
			selectableOptionsCount: selectableCount,
			toAnnouncementGroup,
		};
		return this;
	}

	addEvent({ name = '', description = '', startTime, endTime, location = '', callLink = '', extraGuests = [], isCanceled = false } = {}) {
		if (!name) throw new Error('Event name is required');
		if (!Number.isFinite(startTime)) throw new Error('startTime is required (ms)');

		this._event = {
			name,
			description,
			startTime,
			endTime: endTime ?? startTime + 3600000,
			location,
			callLink,
			extraGuests,
			isCanceled,
		};
		return this;
	}

	addList({ buttonText = 'Buka Menu', title = '', footer = '', body = '' } = {}) {
		this._listData = {
			buttonText,
			title,
			footer,
			body,
			sections: [],
		};
		this._currentListSection = -1;
		return this;
	}

	makeListSection(title = '') {
		if (!this._listData) throw new Error('Call addList() first');
		this._listData.sections.push({ title, rows: [] });
		this._currentListSection = this._listData.sections.length - 1;
		return this;
	}

	makeListRow(title = '', description = '', id = '') {
		if (!this._listData) throw new Error('Call addList() first');
		if (this._currentListSection === -1) throw new Error('Call makeListSection() first');
		this._listData.sections[this._currentListSection].rows.push({
			title,
			description,
			id,
		});
		return this;
	}

	addProductMessage(product = {}, options = {}) {
		if (!product || typeof product !== 'object') {
			throw new TypeError('Product must be an object');
		}

		this._product = {
			...product,
			...options,
		};
		return this;
	}

	addCatalogMessage({ businessOwnerJid = '', title = '', description = '', catalogImage = null } = {}) {
		if (!businessOwnerJid) throw new Error('businessOwnerJid is required');

		this._catalog = {
			businessOwnerJid,
			title,
			description,
			catalogImage,
		};
		return this;
	}

	setTyping(value = true) {
		this._typing = value;
		return this;
	}

	setApi(url, options = {}) {
		this._api = { url, ...options };
		return this;
	}

	static paramsList = {
		limited_time_offer: {
			text: 'string',
			url: 'string',
			copy_code: 'string',
			expiration_time: 'number',
		},
		bottom_sheet: {
			in_thread_buttons_limit: 'number',
			divider_indices: ['number'],
			list_title: 'string',
			button_title: 'string',
		},
		tap_target_configuration: {
			title: 'string',
			description: 'string',
			canonical_url: 'string',
			domain: 'string',
			buttonIndex: 'number',
		},
	};

	async toCard() {
		return {
			body: {
				text: this._body,
			},
			footer: {
				text: this._footer,
			},
			header: {
				title: this._title,
				subtitle: this._subtitle,
				hasMediaAttachment: !!this._data,
				...(this._data
					? await prepareWAMessageMedia(this._data, { upload: this.#client.waUploadToServer }).catch((e) => {
							if (String(e).includes('Invalid media type')) return this._data;
							throw e;
						})
					: {}),
			},
			nativeFlowMessage: {
				messageParamsJson: JSON.stringify(this._params),
				buttons: this._buttons,
			},
		};
	}

	async _preparePayload() {
		const payload = {};

		if (this._poll) {
			payload.pollCreationMessage = {
				name: this._poll.name,
				options: this._poll.options,
				selectableOptionsCount: this._poll.selectableOptionsCount,
				toAnnouncementGroup: this._poll.toAnnouncementGroup,
			};
			return payload;
		}

		if (this._event) {
			payload.eventMessage = {
				name: this._event.name,
				description: this._event.description,
				startTime: this._event.startTime,
				endTime: this._event.endTime,
				location: this._event.location ? { name: this._event.location, degreesLatitude: 0, degreesLongitude: 0 } : undefined,
				callLink: this._event.callLink || undefined,
				extraGuests: this._event.extraGuests.length ? this._event.extraGuests : undefined,
				isCanceled: this._event.isCanceled,
			};
			return payload;
		}

		if (this._product) {
			payload.productMessage = this._product;
			return payload;
		}

		if (this._catalog) {
			payload.catalogMessage = this._catalog;
			return payload;
		}

		if (this._listData) {
			if (!this._listData.sections.length) throw new Error('List requires at least one section');
			payload.listMessage = {
				title: this._listData.title,
				description: this._listData.body,
				buttonText: this._listData.buttonText,
				footerText: this._listData.footer,
				listType: 1,
				sections: this._listData.sections,
				contextInfo: this._contextInfo,
			};
			return payload;
		}

		const message = await this.toCard();
		payload.interactiveMessage = {
			...message,
			contextInfo: this._contextInfo,
		};
		return payload;
	}

	async build(jid, { messageId, ...options } = {}) {
		if (this._api) {
			try {
				const res = await fetch(this._api.url, this._api);
				const data = await res.json();
				if (typeof this._api.transform === 'function') {
					const transformed = this._api.transform(data);
					if (transformed && typeof transformed === 'object') {
						if (transformed.body) this._body = transformed.body;
						if (transformed.footer) this._footer = transformed.footer;
					}
				}
				if (typeof this._api.onResponse === 'function') {
					this._api.onResponse(data);
				}
			} catch (err) {
				if (typeof this._api.onError === 'function') this._api.onError(err);
			}
		}

		const payload = await this._preparePayload();

		return generateWAMessageFromContent(jid, { ...this._extraPayload, ...payload }, { messageId: messageId || generateMessageIDV2(), ...options });
	}

	async send(jid, { messageId, additionalNodes = [], ...options } = {}) {
		if (this._typing !== undefined && this._typing !== false) {
			try {
				await this.#client.sendPresenceUpdate('composing', jid);
				if (typeof this._typing === 'number' && this._typing > 0) {
					await new Promise((r) => setTimeout(r, this._typing));
				}
			} catch {}
		}

		const msg = await this.build(jid, { messageId, ...options });

		await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
			messageId: msg.key.id,
			additionalNodes: [
				{
					tag: 'biz',
					attrs: {},
					content: [
						{
							tag: 'interactive',
							attrs: { type: 'native_flow', v: '1' },
							content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
						},
					],
				},
				...additionalNodes,
			],
			...options,
		});

		if (this._typing !== undefined) {
			try {
				await this.#client.sendPresenceUpdate('paused', jid);
			} catch {}
		}

		return msg;
	}
}

class ButtonV2 extends BaseBuilder {
	#client;

	constructor(client) {
		super();
		if (!client) {
			throw new Error('Socket is required');
		}

		this.#client = client;
		this._image;
		this._data;
		this._buttons = [];
	}

	loadFrom(msg) {
		if (!msg) throw new Error('buttonsMessage needed');
		if (!msg.buttonsMessage) throw new Error('buttonsMessage not found');

		const { buttonsMessage, ...extraPayload } = msg;
		const bM = buttonsMessage;
		const location = bM.locationMessage || {};

		this._title = location.name || '';
		this._subtitle = location.address || '';
		this._body = bM.contentText || '';
		this._footer = bM.footerText || '';
		this._contextInfo = bM.contextInfo || {};
		this._extraPayload = extraPayload;

		this._buttons = Array.isArray(bM.buttons)
			? bM.buttons.map((button) => ({
					...button,
					...(button.nativeFlowInfo
						? {
								nativeFlowInfo: {
									...button.nativeFlowInfo,
									paramsJson: typeof button.nativeFlowInfo.paramsJson === 'string' ? button.nativeFlowInfo.paramsJson : JSON.stringify(button.nativeFlowInfo.paramsJson || {}),
								},
							}
						: {}),
				}))
			: [];

		this._image = location.jpegThumbnail || undefined;

		if (!this._image && bM.locationMessage) {
			this._image = undefined;
		}

		if (!bM.locationMessage && bM.headerType === 6) {
			this._image = undefined;
		}

		this._data = Object.keys(bM).reduce((data, key) => {
			if (!['contentText', 'footerText', 'contextInfo', 'buttons', 'headerType', 'locationMessage', 'viewOnce'].includes(key)) {
				data[key] = bM[key];
			}
			return data;
		}, {});

		if (!Object.keys(this._data).length) {
			this._data = undefined;
		}

		return this;
	}

	addButton(displayText = '', buttonId = crypto.randomUUID()) {
		this._buttons.push({
			buttonId,
			buttonText: { displayText },
			type: 1,
		});
		return this;
	}

	addRawButton(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Buttons must be a plain object');
		}

		this._buttons.push(obj);
		return this;
	}

	setRawThumbnail(thumbnail) {
		if (!thumbnail) throw new Error('Thumbnail needed');
		this._image = { base64: thumbnail, is_raw: true };
		return this;
	}

	setThumbnail(path) {
		if (!path) throw new Error('Url or buffer needed');
		this._image = path;
		return this;
	}

	setMedia(obj) {
		if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
			throw new TypeError('Media must be a plain object');
		}

		this._data = obj;
		return this;
	}

	async build(jid, { messageId, ...options } = {}) {
		const _thumbnail = this._image?.is_raw
			? this._image.base64
			: this._image
				? await Toolkit.resize(Buffer.isBuffer(this._image) ? this._image : await Toolkit.fetchBuffer(this._image, {}, { silent: true }), 300, 300)
				: null;

		const locationMessage = {
			degreesLatitude: 0,
			degreesLongitude: 0,
			name: this._title,
			address: this._subtitle,
		};
		if (_thumbnail) locationMessage.jpegThumbnail = _thumbnail;

		const msg = generateWAMessageFromContent(
			jid,
			{
				...this._extraPayload,
				buttonsMessage: {
					contentText: this._body,
					footerText: this._footer,
					...(this._data
						? this._data
						: {
								headerType: 6,
								locationMessage,
							}),
					viewOnce: true,
					contextInfo: this._contextInfo,
					buttons: [...this._buttons],
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
		return msg;
	}

	async send(jid, { messageId, additionalNodes = [], ...options } = {}) {
		if (this._buttons.length < 1) throw new Error('ButtonV2 requires at least one button');
		const msg = await this.build(jid, { messageId, ...options });

		await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
			messageId: msg.key.id,
			additionalNodes: [
				{
					tag: 'biz',
					attrs: {},
					content: [
						{
							tag: 'interactive',
							attrs: { type: 'native_flow', v: '1' },
							content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
						},
					],
				},
				...additionalNodes,
			],
			...options,
		});
		return msg;
	}
}

class Carousel extends BaseBuilder {
	#client;

	constructor(client) {
		super();
		if (!client) {
			throw new Error('Socket is required');
		}

		this.#client = client;
		this._cards = [];
	}

	loadFrom(msg) {
		if (!msg) throw new Error('interactiveMessage needed');
		if (!msg.interactiveMessage) throw new Error('interactiveMessage not found');

		const { interactiveMessage, ...extraPayload } = msg;
		const iM = interactiveMessage;
		const carousel = iM.carouselMessage || {};

		this._body = iM.body?.text || '';
		this._footer = iM.footer?.text || '';
		this._contextInfo = iM.contextInfo || {};
		this._extraPayload = extraPayload;

		this._cards = Array.isArray(carousel.cards)
			? carousel.cards.map((card) => ({
					...card,
					header: {
						...(card.header || {}),
						hasMediaAttachment: !!card.header?.hasMediaAttachment,
						...(card.header?.imageMessage ? { imageMessage: card.header.imageMessage } : {}),
						...(card.header?.videoMessage ? { videoMessage: card.header.videoMessage } : {}),
					},
					body: {
						text: card.body?.text || '',
					},
					footer: {
						text: card.footer?.text || '',
					},
					nativeFlowMessage: {
						...(card.nativeFlowMessage || {}),
						buttons: Array.isArray(card.nativeFlowMessage?.buttons)
							? card.nativeFlowMessage.buttons.map((button) => ({
									...button,
									buttonParamsJson: typeof button.buttonParamsJson === 'string' ? button.buttonParamsJson : JSON.stringify(button.buttonParamsJson || {}),
								}))
							: [],
						messageParamsJson:
							typeof card.nativeFlowMessage?.messageParamsJson === 'string' ? card.nativeFlowMessage.messageParamsJson : JSON.stringify(card.nativeFlowMessage?.messageParamsJson || {}),
					},
				}))
			: [];

		return this;
	}

	addCard(card) {
		const cards = Array.isArray(card) ? card : [card];
		const baseIndex = this._cards.length;

		for (const [index, c] of cards.entries()) {
			if (!c?.header?.hasMediaAttachment) {
				throw new Error(`Card [${baseIndex + index}] must include an image or video in header`);
			}
		}

		this._cards.push(...cards);
		return this;
	}

	build(jid, { messageId, ...options } = {}) {
		return generateWAMessageFromContent(
			jid,
			{
				...this._extraPayload,
				interactiveMessage: {
					header: {
						hasMediaAttachment: false,
					},
					body: { text: this._body },
					footer: { text: this._footer },
					contextInfo: this._contextInfo,
					carouselMessage: {
						cards: this._cards,
					},
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
	}

	async send(jid, { messageId, additionalNodes = [], ...options } = {}) {
		const msg = this.build(jid, { messageId, ...options });

		await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
			messageId: msg.key.id,
			additionalNodes: [
				{
					tag: 'biz',
					attrs: {},
					content: [
						{
							tag: 'interactive',
							attrs: { type: 'native_flow', v: '1' },
							content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
						},
					],
				},
				...additionalNodes,
			],
			...options,
		});
		return msg;
	}
}

class AIRich extends BaseBuilder {
	#client;

	static _customPrimitives = new Map();

	constructor(client, { dynamic = true, unsupportedTypeAlert = true } = {}) {
		if (!client) {
			throw new Error('Socket is required');
		}

		super();
		this.#client = client;
		this._contextInfo = {};
		this._nodes = [];
		this._idIndex = new Map();
		this._unsupportedTypeAlert = !!unsupportedTypeAlert;
		this._dynamic = !!dynamic;
		this._responseId = crypto.randomUUID();
		this._botResponseId = crypto.randomUUID();
		this._lastMessageKey = null;
	}

	static registerPrimitive(name, builderFn) {
		if (typeof name !== 'string' || !name) throw new TypeError('Primitive name must be a non-empty string');
		if (typeof builderFn !== 'function') throw new TypeError('builderFn must be a function');
		AIRich._customPrimitives.set(name, builderFn);
	}

	static unregisterPrimitive(name) {
		AIRich._customPrimitives.delete(name);
	}

	static listPrimitives() {
		return [...AIRich._customPrimitives.keys()];
	}

	addCustom(name, data, options = {}) {
		if (!AIRich._customPrimitives.has(name)) {
			throw new Error(`Custom primitive "${name}" not registered. Use AIRich.registerPrimitive() first.`);
		}
		const { id, replace, insertAt, layout = 'Single', submessage, ...rest } = options;
		const builderFn = AIRich._customPrimitives.get(name);
		const primitive = builderFn(data, rest);

		if (!primitive || typeof primitive !== 'object') {
			throw new TypeError(`Custom primitive builder "${name}" must return an object`);
		}

		const section = AIRich.newLayout(layout, primitive);
		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	loadFrom(msg) {
		if (!msg) throw new Error('AI Rich message needed');

		const message = msg.message ?? msg;

		let richResponseMessage = message?.botForwardedMessage?.message?.richResponseMessage;

		if (!richResponseMessage) {
			richResponseMessage = message?.botForwardedMessage?.richResponseMessage;
		}

		if (!richResponseMessage) {
			richResponseMessage = message?.richResponseMessage;
		}

		if (!richResponseMessage) {
			throw new Error('richResponseMessage not found');
		}

		const messageContextInfo = message?.messageContextInfo ?? {};
		const botMetadata = messageContextInfo?.botMetadata ?? {};

		this._title = botMetadata?.messageDisclaimerText ?? '';

		this._contextInfo = structuredClone(richResponseMessage?.contextInfo ?? {});

		const loadedSubmessages = Array.isArray(richResponseMessage?.submessages) ? structuredClone(richResponseMessage.submessages) : [];

		let loadedSections = [];

		const unifiedData = richResponseMessage?.unifiedResponse?.data;

		if (unifiedData) {
			try {
				const decoded = Buffer.from(unifiedData, 'base64').toString('utf8');
				const unifiedResponse = JSON.parse(decoded);

				if (Array.isArray(unifiedResponse?.sections)) {
					loadedSections = structuredClone(unifiedResponse.sections);
				}
			} catch {}
		}

		this._nodes = [];
		this._idIndex = new Map();

		const maxLength = Math.max(loadedSections.length, loadedSubmessages.length);

		for (let i = 0; i < maxLength; i++) {
			this._nodes.push({
				id: null,
				section: loadedSections[i] ?? null,
				submessage: loadedSubmessages[i] ?? null,
			});
		}

		this._extraPayload = {};

		for (const [key, value] of Object.entries(message)) {
			if (key !== 'messageContextInfo' && key !== 'botForwardedMessage' && key !== 'richResponseMessage') {
				this._extraPayload[key] = structuredClone(value);
			}
		}

		return this;
	}

	setResponseId(id) {
		if (typeof id !== 'string') {
			throw new TypeError('ID must be a string');
		}
		this._responseId = id;

		return this;
	}

	refreshResponseId() {
		this._responseId = crypto.randomUUID();

		return this;
	}

	setBotResponseId(id) {
		if (typeof id !== 'string') {
			throw new TypeError('ID must be a string');
		}
		this._botResponseId = id;

		return this;
	}

	refreshBotResponseId() {
		this._botResponseId = crypto.randomUUID();

		return this;
	}

	createAlert(type) {
		if (this._unsupportedTypeAlert) {
			return {
				messageType: 2,
				messageText: `[ UNSUPPORTED_TYPE - ${type}]`,
			};
		}

		return undefined;
	}

	addText(text, { hyperlink = true, citation = true, latex = true, id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const { text: extractedText, inline_entities } = extractIE(text, {
			hyperlink,
			citation,
			latex,
		});

		const section = AIRich.newLayout('Single', {
			text: extractedText,
			...(inline_entities.length && { inline_entities }),
			__typename: 'GenAIMarkdownTextUXPrimitive',
		});

		const submessages = [
			{
				messageType: 2,
				messageText: text,
			},
		].filter(Boolean);

		return this._addContent(section, submessages, {
			id,
			replace,
			insertAt,
		});
	}

	addFOAText(text, { id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const section = AIRich.newLayout('Single', {
			text,
			__typename: 'FOATextPrimitive',
		});

		const submessages = [
			{
				messageType: 2,
				messageText: text,
			},
		];

		return this._addContent(section, submessages, {
			id,
			replace,
			insertAt,
		});
	}

	addCode(language, code, { id, replace, insertAt } = {}) {
		if (typeof language !== 'string' || typeof code !== 'string') {
			throw new TypeError('Language and code must be a string');
		}

		const meta = AIRich.tokenizer(code, language);

		const section = AIRich.newLayout('Single', {
			language,
			code_blocks: meta.unified_codeBlock,
			__typename: 'GenAICodeUXPrimitive',
		});

		const submessages = [
			{
				messageType: 5,
				codeMetadata: {
					codeLanguage: language,
					codeBlocks: meta.codeBlock,
				},
			},
		];

		return this._addContent(section, submessages, {
			id,
			replace,
			insertAt,
		});
	}

	addTable(table, { hyperlink = true, citation = true, latex = true, id, replace, insertAt } = {}) {
		if (!Array.isArray(table)) {
			throw new TypeError('Table must be an array');
		}

		const meta = AIRich.toTableMetadata(table, {
			hyperlink,
			citation,
			latex,
		});

		const section = AIRich.newLayout('Single', {
			rows: meta.unified_rows,
			__typename: 'GenATableUXPrimitive',
		});

		const submessages = [
			{
				messageType: 4,
				tableMetadata: {
					title: meta.title,
					rows: meta.rows,
				},
			},
		];

		return this._addContent(section, submessages, {
			id,
			replace,
			insertAt,
		});
	}

	addSource(sources = [], { id, replace, insertAt } = {}) {
		if (!Array.isArray(sources)) {
			throw new TypeError('Sources must be an array of strings, arrays, or objects');
		}

		const isStringArray = sources.every((item) => typeof item === 'string');

		const isArrayFormat = sources.every((item) => Array.isArray(item) && item.every((value) => typeof value === 'string'));

		const isObjectFormat = sources.every((item) => item && typeof item === 'object' && !Array.isArray(item));

		if (!isStringArray && !isArrayFormat && !isObjectFormat) {
			throw new TypeError('Sources must be a string array, array of string arrays, or array of objects');
		}

		if (isStringArray) {
			sources = [sources];
		}

		const normalizedSources = sources.map((source) => {
			if (Array.isArray(source)) {
				const [icon, url, title, subtitle] = source;

				return {
					icon,
					url,
					title,
					subtitle,
				};
			}

			return {
				icon: source.favicon ?? source.icon ?? '',
				url: source.url ?? '',
				title: source.title ?? '',
				subtitle: source.subtitle ?? '',
			};
		});

		const source = normalizedSources.map(({ icon, url, title, subtitle }) => ({
			source_type: 'THIRD_PARTY',
			source_display_name: title,
			source_subtitle: subtitle,
			source_url: url,
			favicon: {
				url: Toolkit.resolveMedia(this.#client, icon, 'image'),
				mime_type: 'image/jpeg',
				width: 16,
				height: 16,
			},
		}));

		const submessage = this.createAlert('GenAISearchResultPrimitive');

		const section = AIRich.newLayout('Single', {
			sources: source,
			__typename: 'GenAISearchResultPrimitive',
		});

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addReels(reelsItems = [], { id, replace, insertAt } = {}) {
		if (
			!(
				(reelsItems && typeof reelsItems === 'object' && !Array.isArray(reelsItems)) ||
				(Array.isArray(reelsItems) && reelsItems.every((item) => item && typeof item === 'object' && !Array.isArray(item)))
			)
		) {
			throw new TypeError('Reels items must be an object or an array of objects');
		}

		const items = Array.isArray(reelsItems) ? reelsItems : [reelsItems];

		const reels = items.map((item) => ({
			...item,
			_avatar: Toolkit.resolveMedia(this.#client, item.profileIconUrl ?? item.profile_url ?? item.profile ?? '', 'image'),
			_thumbnail: Toolkit.resolveMedia(this.#client, item.thumbnailUrl ?? item.thumbnail ?? '', 'image'),
		}));

		const section = AIRich.newLayout(
			'HScroll',
			reels.map((item) => ({
				reels_url: item.videoUrl ?? item.url ?? '',
				thumbnail_url: item._thumbnail,
				creator: item.username ?? item.title ?? '',
				avatar_url: item._avatar,
				reels_title: item.reels_title ?? item.title ?? '',
				likes_count: item.likes_count ?? item.like ?? 0,
				shares_count: item.shares_count ?? item.share ?? 0,
				view_count: item.view_count ?? item.view ?? 0,
				reel_source: item.reel_source ?? item.source ?? 'IG',
				is_verified: !!(item.is_verified || item.verified),
				__typename: 'GenAIReelPrimitive',
			}))
		);

		const submessages = [
			{
				messageType: 9,
				contentItemsMetadata: {
					contentType: 1,
					itemsMetadata: reels.map((item) => ({
						reelItem: {
							title: item.username ?? '',
							profileIconUrl: item._avatar,
							thumbnailUrl: item._thumbnail,
							videoUrl: item.videoUrl ?? item.url ?? '',
						},
					})),
				},
			},
		];

		return this._addContent(section, submessages, {
			id,
			replace,
			insertAt,
		});
	}

	addImage(imageUrl, { width, height, status = 'READY', update_text, resolveUrl = false, id, replace, insertAt } = {}) {
		if (!(typeof imageUrl === 'string' || Buffer.isBuffer(imageUrl) || (Array.isArray(imageUrl) && imageUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v))))) {
			throw new TypeError('imageUrl must be string | buffer | array of string/buffer');
		}

		const list = Array.isArray(imageUrl)
			? imageUrl.map((v) => {
					const url = resolveAIRichSource(this.#client, v, 'image');

					return {
						imagePreviewUrl: url,
						imageHighResUrl: url,
						sourceUrl: url,
					};
				})
			: (() => {
					const url = resolveAIRichSource(this.#client, imageUrl, 'image');

					return [
						{
							imagePreviewUrl: url,
							imageHighResUrl: url,
							sourceUrl: url,
						},
					];
				})();

		const sections = list.map(({ imagePreviewUrl }) =>
			AIRich.newLayout('Single', {
				media: {
					url: imagePreviewUrl,
					mime_type: inferImageMime(typeof imageUrl === 'string' ? imageUrl : '', 'image/png'),
					width,
					height,
				},
				imagine_type: 'IMAGE',
				status: {
					status,
					update_text,
				},
				__typename: 'GenAIImaginePrimitive',
			})
		);

		const submessage = {
			messageType: 1,
			gridImageMetadata: {
				gridImageUrl: {
					imagePreviewUrl: list[0]?.imagePreviewUrl,
				},
				imageUrls: list,
			},
		};

		if (id && sections.length !== 1) {
			throw new Error('Cannot assign one id to multiple image sections');
		}

		return this._addContent(sections, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addImageGallery(items = [], { columns = 2, id, replace, insertAt } = {}) {
		if (!Array.isArray(items) || !items.length) {
			throw new TypeError('Gallery items must be a non-empty array');
		}

		const normalized = items.map((it) => {
			if (typeof it === 'string') return { url: it, caption: '' };
			if (it && typeof it === 'object' && it.url) return { url: it.url, caption: it.caption ?? '' };
			throw new TypeError('Each gallery item must be string or { url, caption }');
		});

		const resolved = normalized.map((it) => ({
			...it,
			_url: resolveAIRichSource(this.#client, it.url, 'image'),
		}));

		const primitives = resolved.map((it) => ({
			media: {
				url: it._url,
				mime_type: inferImageMime(it.url, 'image/png'),
			},
			caption: it.caption,
			__typename: 'GenAIImageGalleryItemPrimitive',
		}));

		const section = AIRich.newLayout('HScroll', primitives, {
			columns,
			__typename: 'GenAIImageGalleryLayoutViewModel',
		});

		const submessage = {
			messageType: 1,
			gridImageMetadata: {
				gridImageUrl: { imagePreviewUrl: resolved[0]?._url },
				imageUrls: resolved.map((it) => ({
					imagePreviewUrl: it._url,
					imageHighResUrl: it._url,
					sourceUrl: it._url,
				})),
			},
		};

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addVideo(videoUrl, { autoFill = true, status = 'READY', estimatedTime, id, replace, insertAt } = {}) {
		const isObjectVideo = (v) => v && typeof v === 'object' && !Array.isArray(v) && v.url;

		const isValidPrimitive =
			typeof videoUrl === 'string' ||
			Buffer.isBuffer(videoUrl) ||
			isObjectVideo(videoUrl) ||
			(Array.isArray(videoUrl) && videoUrl.every((v) => typeof v === 'string' || Buffer.isBuffer(v) || isObjectVideo(v)));

		if (!isValidPrimitive) {
			throw new TypeError('videoUrl must be string | buffer | object | array');
		}

		const items = Array.isArray(videoUrl) ? videoUrl : [videoUrl];

		const alert = this.createAlert('GenAIImaginePrimitive (ANIMATE)');

		const sections = [];
		const submessages = [];

		for (const item of items) {
			const isObject = isObjectVideo(item);

			const url = isObject ? resolveAIRichSource(this.#client, item.url ?? '', 'video') : resolveAIRichSource(this.#client, item, 'video');

			const bufferPromise = autoFill ? Promise.resolve(url).then((u) => Toolkit.fetchBuffer(u)) : null;

			const file_length = isObject && item.file_length != null ? item.file_length : autoFill ? bufferPromise.then((b) => b?.length ?? 0) : 0;

			const duration =
				isObject && item.duration != null
					? item.duration
					: autoFill
						? bufferPromise.then((b) =>
								Toolkit.getMp4Duration(b, {
									silent: true,
								})
							)
						: 0;

			const thumbnail =
				isObject && item.thumbnail
					? resolveAIRichSource(this.#client, item.thumbnail, 'image')
					: autoFill
						? bufferPromise?.then((b) =>
								Toolkit.getMp4Preview(b, {
									time: 0,
									result: 'base64',
								})
							)
						: null;

			sections.push(
				AIRich.newLayout('Single', {
					media: {
						url,
						mime_type: isObject ? (item.mime_type ?? inferVideoMime(url)) : inferVideoMime(url),
						file_length,
						duration,
					},
					imagine_type: 'ANIMATE',
					status: {
						status,
						estimated_completion_time: estimatedTime != null ? Math.floor((Date.now() + estimatedTime) / 1000) : undefined,
					},
					thumbnail: {
						raw_media: thumbnail,
					},
					__typename: 'GenAIImaginePrimitive',
				})
			);
		}

		if (alert !== undefined) {
			submessages.push(alert);
		}

		if (submessages.length > 1) {
			throw new Error('Video content can only have one submessage');
		}

		return this._addContent(sections, submessages[0], {
			id,
			replace,
			insertAt,
		});
	}

	addVideoPlayer({ url = '', poster = '', controls = true, autoplay = false, loop = false, width, height, id, replace, insertAt } = {}) {
		if (!url) throw new Error('Video url is required');

		const _url = resolveAIRichSource(this.#client, url, 'video');
		const _poster = poster ? resolveAIRichSource(this.#client, poster, 'image') : null;

		const section = AIRich.newLayout('Single', {
			media: {
				url: _url,
				mime_type: inferVideoMime(url),
				poster: _poster,
				controls,
				autoplay,
				loop,
				width,
				height,
			},
			imagine_type: 'VIDEO_PLAYER',
			__typename: 'GenAIVideoPlayerPrimitive',
		});

		const submessage = this.createAlert('GenAIVideoPlayerPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addProfileCard({ name = '', username = '', avatar = '', description = '', verified = false, details = [], footer = '', id, replace, insertAt } = {}) {
		if (typeof name !== 'string' || !name.trim()) {
			throw new TypeError('Profile name is required');
		}

		if (typeof username !== 'string' || typeof description !== 'string') {
			throw new TypeError('Username and description must be strings');
		}

		if (!Array.isArray(details)) {
			throw new TypeError('Profile details must be an array');
		}

		for (const detail of details) {
			if (!detail || typeof detail !== 'object' || detail.label == null || detail.value == null) {
				throw new TypeError('Each detail needs label and value');
			}
		}

		const avatarUrl = avatar ? resolveAIRichSource(this.#client, avatar, 'image') : null;

		const profile = {
			name,
			username: username ? (username.startsWith('@') ? username : `@${username}`) : '',
			description,
			verified: Boolean(verified),
			details: details.map(({ label, value }) => ({
				label: String(label),
				value: String(value),
			})),
			...(avatarUrl
				? {
						avatar: {
							url: avatarUrl,
							mime_type: inferImageMime(typeof avatar === 'string' ? avatar : '', 'image/jpeg'),
						},
					}
				: {}),
			__typename: 'GenAIProfileCardPrimitive',
		};

		const section = AIRich.newLayout('Single', profile);

		const lines = [name, username ? `@${username.replace(/^@/, '')}` : '', description, ...details.map(({ label, value }) => `${label}: ${value}`), footer].filter(Boolean);

		const submessage = [
			{
				messageType: 2,
				messageText: lines.join('\n'),
			},
		];

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addMusicCard({ url = '', file = '', buffer = null, source = null, waveform = [], duration = 0, title = '', artist = '', album = '', cover = '', mimeType = '', mime_type = '', id, replace, insertAt } = {}) {
		const mediaSource = source ?? buffer ?? file ?? url;

		if (!mediaSource) {
			throw new Error('Music source is required: pass url, file, buffer, or source');
		}

		if (!Array.isArray(waveform)) {
			throw new TypeError('Waveform must be an array');
		}

		if (!Number.isFinite(duration) || duration < 0) {
			throw new TypeError('Duration must be a non-negative number');
		}

		if (typeof title !== 'string' || typeof artist !== 'string' || typeof album !== 'string') {
			throw new TypeError('Title, artist, and album must be strings');
		}

		const audioUrl = resolveAIRichSource(this.#client, mediaSource, 'audio');

		const coverUrl = cover ? resolveAIRichSource(this.#client, cover, 'image') : null;

		const mime = mimeType || mime_type || inferAudioMime(mediaSource);

		const section = AIRich.newLayout('Single', {
			media: {
				url: audioUrl,
				mime_type: mime,
				cover: coverUrl,
				title,
				artist,
				album,
				duration,
				waveform,
			},
			imagine_type: 'AUDIO_PLAYER',
			__typename: 'GenAIAudioPlayerPrimitive',
		});

		const submessage = this.createAlert('GenAIAudioPlayerPrimitive');

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addAudioPlayer(options = {}) {
		return this.addMusicCard(options);
	}

	addSticker(sticker, { packName = '', author = '', id, replace, insertAt } = {}) {
		if (!(typeof sticker === 'string' || Buffer.isBuffer(sticker))) {
			throw new TypeError('Sticker must be string | buffer');
		}

		const _url = resolveAIRichSource(this.#client, sticker, 'image');

		const section = AIRich.newLayout('Single', {
			media: {
				url: _url,
				mime_type: 'image/webp',
			},
			sticker_metadata: {
				pack_name: packName,
				author,
			},
			__typename: 'GenAIStickerPrimitive',
		});

		const submessage = this.createAlert('GenAIStickerPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addCalendar({ month = new Date().getMonth(), year = new Date().getFullYear(), events = [], id, replace, insertAt } = {}) {
		const section = AIRich.newLayout('Single', {
			month,
			year,
			events: events.map((e) => ({
				date: e.date,
				title: e.title ?? '',
			})),
			__typename: 'GenAICalendarPrimitive',
		});

		const submessage = this.createAlert('GenAICalendarPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addQuiz({ question = '', options = [], answer = 0, reward = '', id, replace, insertAt } = {}) {
		if (!question) throw new Error('Quiz question is required');
		if (!Array.isArray(options) || options.length < 2) {
			throw new Error('Quiz requires at least 2 options');
		}

		const section = AIRich.newLayout('Single', {
			question,
			options,
			correct_index: answer,
			reward,
			__typename: 'GenAIQuizPrimitive',
		});

		const submessage = this.createAlert('GenAIQuizPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addChannelMessage({ channelJid = '', body = '', media = null, id, replace, insertAt } = {}) {
		if (!channelJid) throw new Error('channelJid is required');

		const section = AIRich.newLayout('Single', {
			channel_jid: channelJid,
			body,
			media: media ? resolveAIRichSource(this.#client, media, 'image') : null,
			__typename: 'GenAIChannelPostPrimitive',
		});

		const submessage = this.createAlert('GenAIChannelPostPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addLiveLocation({ lat = 0, lng = 0, duration = 3600, caption = '', id, replace, insertAt } = {}) {
		const section = AIRich.newLayout('Single', {
			latitude: lat,
			longitude: lng,
			duration,
			caption,
			is_live: true,
			__typename: 'GenAILiveLocationPrimitive',
		});

		const submessage = this.createAlert('GenAILiveLocationPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addContact(data = {}, { id, replace, insertAt } = {}) {
		const isArray = Array.isArray(data);
		const items = isArray ? data : [data];

		if (!items.every((it) => it && typeof it === 'object')) {
			throw new TypeError('Contact must be an object or array of objects');
		}

		const contacts = items.map((it) => ({
			name: it.name ?? '',
			phone: it.phone ?? '',
			organization: it.organization ?? '',
			email: it.email ?? '',
			avatar: it.avatar ? resolveAIRichSource(this.#client, it.avatar, 'image') : null,
			__typename: 'GenAIContactPrimitive',
		}));

		const section = AIRich.newLayout(isArray ? 'HScroll' : 'Single', isArray ? contacts : contacts[0]);

		const submessage = this.createAlert('GenAIContactPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addCamera({ facing = 'environment', audio = false, mode = 'photo', id, replace, insertAt } = {}) {
		const section = AIRich.newLayout('Single', {
			permission: {
				name: 'camera',
				state: 'PROMPT',
			},
			config: {
				facing,
				audio,
				mode,
			},
			__typename: 'GenAICameraPrimitive',
		});

		const submessage = this.createAlert('GenAICameraPrimitive');

		return this._addContent(section, submessage, { id, replace, insertAt });
	}

	addProduct(data = {}, { id, replace, insertAt } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Product items must be an object or an array of objects');
		}

		const items = Array.isArray(data) ? data : [data];

		const product = items.map((item) => ({
			title: item.title,
			brand: item.brand,
			price: item.price,
			sale_price: item.sale_price,
			product_url: item.product_url ?? item.url,
			image: {
				url: resolveAIRichSource(this.#client, item.image_url ?? item.image, 'image'),
			},
			additional_images: [
				{
					url: item.icon_url || item.icon ? resolveAIRichSource(this.#client, item.icon_url ?? item.icon, 'image') : null,
				},
			],
			__typename: 'GenAIProductItemCardPrimitive',
		}));

		const section = AIRich.newLayout(Array.isArray(data) ? 'HScroll' : 'Single', Array.isArray(data) ? product : product[0]);

		const submessage = this.createAlert('GenAIProductItemCardPrimitive');

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addPost(data = {}, { id, replace, insertAt } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Post items must be an object or an array of objects');
		}

		const posts = Array.isArray(data) ? data : [data];

		const primitives = posts.map((p) => ({
			title: p.title ?? '',
			subtitle: p.subtitle ?? '',
			username: p.username ?? '',
			profile_picture_url: resolveAIRichSource(this.#client, p.profile_picture_url ?? p.profile_url ?? p.profile ?? '', 'image'),
			is_verified: !!(p.is_verified || p.verified),
			thumbnail_url: resolveAIRichSource(this.#client, p.thumbnail_url ?? p.thumbnail ?? '', 'image'),
			post_caption: p.post_caption ?? p.caption ?? '',
			likes_count: p.likes_count ?? p.like ?? 0,
			comments_count: p.comments_count ?? p.comment ?? 0,
			shares_count: p.shares_count ?? p.share ?? 0,
			post_url: p.post_url ?? p.url ?? '',
			post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
			source_app: p.source_app || p.source || 'INSTAGRAM',
			footer_label: p.footer_label ?? p.footer ?? '',
			footer_icon: resolveAIRichSource(this.#client, p.footer_icon ?? p.icon ?? '', 'image'),
			is_carousel: posts.length > 1,
			orientation: p.orientation ?? 'LANDSCAPE',
			post_type: p.post_type ?? 'VIDEO',
			__typename: 'GenAIPostPrimitive',
		}));

		const section = AIRich.newLayout('HScroll', primitives);

		const submessage = this.createAlert('GenAIPostPrimitive');

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addMetadata(text, { id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const section = AIRich.newLayout('Single', {
			text,
			__typename: 'GenAIMetadataTextPrimitive',
		});

		const submessage = {
			messageType: 2,
			messageText: text,
		};

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addTip(text, { id, replace, insertAt } = {}) {
		if (typeof text !== 'string') {
			throw new TypeError('Text must be a string');
		}

		const section = AIRich.newLayout('Single', {
			text: 'ⓘ ' + text,
			__typename: 'GenAIMetadataTextPrimitive',
		});

		const submessage = {
			messageType: 2,
			messageText: text,
		};

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addWidget(data, { layout, id, replace, insertAt, ...options } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Widget must be an object or an array of objects');
		}

		const isArray = Array.isArray(data);

		const items = isArray ? data : [data];

		const widgets = items.map((item) => ({
			__typename: 'GenAI3PExtWidgetPrimitive',

			header: {
				__typename: 'GenAI3PExtWidgetStandardHeader',
				title: item.title ?? '',
				...(item.header ?? {}),
			},

			body: {
				__typename: 'GenAI3PExtCalendarEventList',
				sections: item.sections ?? [],

				ctas: (item.actions ?? []).map((action) => ({
					__typename: 'GenAI3PExtWidgetCTA',
					label: action.label ?? '',
					state: action.state ?? 'PENDING',
					kind: action.kind ?? 'OTHER',
					tool_call_id: action.tool_call_id ?? action.id ?? '',

					...(action.toast && {
						toast: {
							__typename: 'GenAI3PExtWidgetToast',
							label: action.toast.label ?? action.label ?? '',
						},
					}),
				})),

				...(item.body ?? {}),
			},
		}));

		const section = AIRich.newLayout(layout ?? (isArray ? 'HScroll' : 'Single'), isArray ? widgets : widgets[0], options);

		const submessage = this.createAlert('GenAI3PExtWidgetStandardHeader');

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addFooterAction(data, { layout, id, replace, insertAt, ...options } = {}) {
		if (!((data && typeof data === 'object' && !Array.isArray(data)) || (Array.isArray(data) && data.every((item) => item && typeof item === 'object' && !Array.isArray(item))))) {
			throw new TypeError('Footer action must be an object or an array of objects');
		}

		const isArray = Array.isArray(data);

		const items = isArray ? data : [data];

		const actions = items.map((item) => ({
			__typename: 'GenAIFooterActionPrimitive',

			cta_text: item.text ?? item.cta_text ?? '',

			cta_type: item.type ?? item.cta_type ?? 'OPEN_URL',

			cta_url: item.url ?? item.cta_url ?? '',
		}));

		const section = AIRich.newLayout(layout ?? (isArray ? 'HScroll' : 'Single'), isArray ? actions : actions[0], options);

		const submessage = this.createAlert('GenAIFooterActionPrimitive');

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	addSuggest(suggestion, { scroll = true, layout, id, replace, insertAt } = {}) {
		if (!(typeof suggestion === 'string' || (Array.isArray(suggestion) && suggestion.every((v) => typeof v === 'string')))) {
			throw new TypeError('Suggestion must be a string or array of strings');
		}

		const suggest = Array.isArray(suggestion)
			? suggestion.map((text) => ({
					prompt_text: text,
					prompt_type: 'SUGGESTED_PROMPT',
					__typename: 'GenAIFollowUpSuggestionPillPrimitive',
				}))
			: [
					{
						prompt_text: suggestion,
						prompt_type: 'SUGGESTED_PROMPT',
						__typename: 'GenAIFollowUpSuggestionPillPrimitive',
					},
				];

		const type = layout ?? (suggest.length === 1 ? 'Single' : scroll ? 'HScroll' : 'ActionRow');

		const section = AIRich.newLayout(type, type === 'Single' ? suggest[0] : suggest, {
			__typename: 'GenAIUnifiedResponseSection',
		});

		const submessage = this.createAlert('GenAIFollowUpSuggestionPillPrimitive');

		return this._addContent(section, submessage, {
			id,
			replace,
			insertAt,
		});
	}

	async build(
		jid,
		{ bypassDownload = true, forwarded = true, notification = false, includesUnifiedResponse = true, includesSubmessages = true, quoted, quotedParticipant, messageId, ...options } = {}
	) {
		const forward = forwarded
			? {
					forwardingScore: 1,
					isForwarded: true,
					forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
					forwardOrigin: 4,
				}
			: {};

		const notif = notification
			? {
					sessionTransparencyMetadata: {
						disclaimerText: '~ Ahmad tumbuh kembang',
						hcaId: `hca_${Date.now()}`,
						sessionTransparencyType: 1,
					},
				}
			: {};

		const qObj = quoted
			? {
					stanzaId: quoted?.key?.id || quoted?.id,
					participant: quotedParticipant || quoted?.key?.participant || quoted?.participant || quoted?.key?.remoteJid,
					quotedType: 0,
					quotedMessage: typeof quoted === 'object' && quoted !== null ? (quoted.message ?? quoted) : undefined,
				}
			: {};

		const sections = this._footer
			? [
					...(await waitAllPromises(this._sections)),
					AIRich.newLayout('Single', {
						text: this._footer,
						__typename: 'GenAIMetadataTextPrimitive',
					}),
				]
			: [...(await waitAllPromises(this._sections))];

		if (this._dynamic) {
			this.refreshResponseId();
			this.refreshBotResponseId();
		}

		return generateWAMessageFromContent(
			jid,
			{
				messageContextInfo: {
					deviceListMetadata: {},
					deviceListMetadataVersion: 2,
					botMetadata: {
						messageDisclaimerText: this._title,
						...notif,
						verificationMetadata: AIRich.generateVerificationMetadata(),
						botResponseId: this._botResponseId,
					},
				},
				...this._extraPayload,
				botForwardedMessage: {
					message: {
						richResponseMessage: {
							messageType: 1,
							submessages: includesSubmessages ? await waitAllPromises(this._submessages) : [],
							unifiedResponse: {
								data: includesUnifiedResponse ? Buffer.from(Toolkit.stringifyEscaped({ response_id: this._responseId, sections })).toString('base64') : '',
							},
							contextInfo: {
								...forward,
								...qObj,
								...this._contextInfo,
							},
						},
					},
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
	}

	async buildEdit(targetJid, targetId, { msg, messageId, ...options } = {}) {
		if (!msg) {
			msg = (await this.build(targetJid, options)).message;
		}

		const editedMessage = msg;

		if (!editedMessage) {
			throw new Error('buildEdit: msg does not contain botForwardedMessage');
		}

		return generateWAMessageFromContent(
			targetJid,
			{
				botForwardedMessage: {
					message: {
						protocolMessage: {
							key: {
								remoteJid: targetJid,
								fromMe: true,
								id: targetId,
							},
							type: 14,
							editedMessage,
						},
					},
				},
			},
			{ messageId: messageId || generateMessageIDV2(), ...options }
		);
	}

	async sendEdit(jid, id, { msg, messageId, additionalNodes = [], ...options } = {}) {
		jid = jid ?? this._lastMessageKey?.remoteJid;
		id = id ?? this._lastMessageKey?.id;

		if (!jid) {
			throw new Error('JID is required');
		}

		if (!id) {
			throw new Error('Message id is required');
		}

		const msgEdit = await this.buildEdit(jid, id, {
			msg,
			messageId: messageId || generateMessageIDV2(),
			...options,
		});

		await this.#client.relayMessage(jid, msgEdit.message, {
			messageId: msgEdit.key.id,
			additionalNodes,
		});

		return msgEdit;
	}

	async send(jid, { bypassDownload = true, forwarded = true, notification = false, includesUnifiedResponse = true, includesSubmessages = true, messageId, additionalNodes = [], ...options } = {}) {
		const msg = await this.build(jid, {
			forwarded,
			notification,
			includesUnifiedResponse,
			includesSubmessages,
			messageId,
			...options,
		});

		await this.#client.relayMessage(msg.key.remoteJid, msg.message, {
			messageId: msg.key.id,
			additionalNodes,
			...options,
		});

		if (includesUnifiedResponse && bypassDownload) {
			await this.sendEdit(jid, msg.key.id, {
				msg: msg.message,
			});
		}

		this._lastMessageKey = msg.key;

		return msg;
	}

	static tokenizer(code, lang = 'javascript') {
		const keywordsMap = {
			javascript: new Set([
				'break',
				'case',
				'catch',
				'continue',
				'debugger',
				'delete',
				'do',
				'else',
				'finally',
				'for',
				'function',
				'if',
				'in',
				'instanceof',
				'new',
				'return',
				'switch',
				'this',
				'throw',
				'try',
				'typeof',
				'var',
				'void',
				'while',
				'with',
				'true',
				'false',
				'null',
				'undefined',
				'class',
				'const',
				'let',
				'super',
				'extends',
				'export',
				'import',
				'yield',
				'static',
				'constructor',
				'async',
				'await',
				'get',
				'set',
			]),

			typescript: new Set([
				'abstract',
				'any',
				'as',
				'asserts',
				'bigint',
				'boolean',
				'declare',
				'enum',
				'implements',
				'infer',
				'interface',
				'is',
				'keyof',
				'module',
				'namespace',
				'never',
				'readonly',
				'require',
				'number',
				'object',
				'override',
				'private',
				'protected',
				'public',
				'satisfies',
				'string',
				'symbol',
				'type',
				'unknown',
				'using',
				'from',
				'break',
				'case',
				'catch',
				'continue',
				'do',
				'else',
				'finally',
				'for',
				'function',
				'if',
				'new',
				'return',
				'switch',
				'this',
				'throw',
				'try',
				'var',
				'void',
				'while',
				'class',
				'const',
				'let',
				'extends',
				'import',
				'export',
				'async',
				'await',
			]),

			python: new Set([
				'False',
				'None',
				'True',
				'and',
				'as',
				'assert',
				'async',
				'await',
				'break',
				'class',
				'continue',
				'def',
				'del',
				'elif',
				'else',
				'except',
				'finally',
				'for',
				'from',
				'global',
				'if',
				'import',
				'in',
				'is',
				'lambda',
				'nonlocal',
				'not',
				'or',
				'pass',
				'raise',
				'return',
				'try',
				'while',
				'with',
				'yield',
			]),

			java: new Set([
				'abstract',
				'assert',
				'boolean',
				'break',
				'byte',
				'case',
				'catch',
				'char',
				'class',
				'const',
				'continue',
				'default',
				'do',
				'double',
				'else',
				'enum',
				'extends',
				'final',
				'finally',
				'float',
				'for',
				'goto',
				'if',
				'implements',
				'import',
				'instanceof',
				'int',
				'interface',
				'long',
				'native',
				'new',
				'package',
				'private',
				'protected',
				'public',
				'return',
				'short',
				'static',
				'strictfp',
				'super',
				'switch',
				'synchronized',
				'this',
				'throw',
				'throws',
				'transient',
				'try',
				'void',
				'volatile',
				'while',
			]),

			golang: new Set([
				'break',
				'case',
				'chan',
				'const',
				'continue',
				'default',
				'defer',
				'else',
				'fallthrough',
				'for',
				'func',
				'go',
				'goto',
				'if',
				'import',
				'interface',
				'map',
				'package',
				'range',
				'return',
				'select',
				'struct',
				'switch',
				'type',
				'var',
			]),

			c: new Set([
				'auto',
				'break',
				'case',
				'char',
				'const',
				'continue',
				'default',
				'do',
				'double',
				'else',
				'enum',
				'extern',
				'float',
				'for',
				'goto',
				'if',
				'int',
				'long',
				'register',
				'return',
				'short',
				'signed',
				'sizeof',
				'static',
				'struct',
				'switch',
				'typedef',
				'union',
				'unsigned',
				'void',
				'volatile',
				'while',
			]),

			cpp: new Set([
				'alignas',
				'alignof',
				'and',
				'auto',
				'bool',
				'break',
				'case',
				'catch',
				'class',
				'const',
				'constexpr',
				'continue',
				'delete',
				'do',
				'double',
				'else',
				'enum',
				'explicit',
				'export',
				'extern',
				'false',
				'float',
				'for',
				'friend',
				'if',
				'inline',
				'int',
				'long',
				'mutable',
				'namespace',
				'new',
				'noexcept',
				'nullptr',
				'operator',
				'private',
				'protected',
				'public',
				'return',
				'short',
				'signed',
				'sizeof',
				'static',
				'struct',
				'switch',
				'template',
				'this',
				'throw',
				'true',
				'try',
				'typedef',
				'typename',
				'union',
				'unsigned',
				'using',
				'virtual',
				'void',
				'while',
			]),

			php: new Set([
				'abstract',
				'and',
				'array',
				'as',
				'break',
				'callable',
				'case',
				'catch',
				'class',
				'clone',
				'const',
				'continue',
				'declare',
				'default',
				'do',
				'echo',
				'else',
				'elseif',
				'empty',
				'enddeclare',
				'endfor',
				'endforeach',
				'endif',
				'endswitch',
				'endwhile',
				'extends',
				'final',
				'finally',
				'fn',
				'for',
				'foreach',
				'function',
				'global',
				'goto',
				'if',
				'implements',
				'include',
				'include_once',
				'instanceof',
				'interface',
				'match',
				'namespace',
				'new',
				'null',
				'or',
				'private',
				'protected',
				'public',
				'require',
				'require_once',
				'return',
				'static',
				'switch',
				'throw',
				'trait',
				'try',
				'use',
				'var',
				'while',
				'yield',
			]),

			rust: new Set([
				'as',
				'break',
				'const',
				'continue',
				'crate',
				'else',
				'enum',
				'extern',
				'false',
				'fn',
				'for',
				'if',
				'impl',
				'in',
				'let',
				'loop',
				'match',
				'mod',
				'move',
				'mut',
				'pub',
				'ref',
				'return',
				'self',
				'Self',
				'static',
				'struct',
				'super',
				'trait',
				'true',
				'type',
				'unsafe',
				'use',
				'where',
				'while',
			]),

			html: new Set([
				'html',
				'head',
				'body',
				'div',
				'span',
				'p',
				'a',
				'img',
				'video',
				'audio',
				'script',
				'style',
				'link',
				'meta',
				'form',
				'input',
				'button',
				'table',
				'tr',
				'td',
				'th',
				'ul',
				'ol',
				'li',
				'section',
				'article',
				'header',
				'footer',
				'nav',
				'main',
			]),

			bash: new Set([
				'if',
				'then',
				'else',
				'elif',
				'fi',
				'for',
				'while',
				'do',
				'done',
				'case',
				'esac',
				'function',
				'in',
				'select',
				'until',
				'break',
				'continue',
				'return',
				'export',
				'readonly',
				'local',
				'declare',
			]),

			markdown: new Set(['#', '##', '###', '####', '#####', '######']),
		};

		if (!lang || lang === 'txt' || lang === 'text' || lang === 'plaintext') {
			return {
				codeBlock: [
					{
						codeContent: code,
						highlightType: 0,
					},
				],
				unified_codeBlock: [
					{
						content: code,
						type: 'DEFAULT',
					},
				],
			};
		}

		const TYPE_MAP = {
			0: 'DEFAULT',
			1: 'KEYWORD',
			2: 'METHOD',
			3: 'STR',
			4: 'NUMBER',
			5: 'COMMENT',
		};

		const keywords = keywordsMap[lang.toLowerCase()] || new Set();
		const tokens = [];

		let i = 0;

		const push = (content, type) => {
			if (!content) return;

			const last = tokens[tokens.length - 1];

			if (last && last.highlightType === type) {
				last.codeContent += content;
			} else {
				tokens.push({
					codeContent: content,
					highlightType: type,
				});
			}
		};

		const isIdentifier = (char) => {
			switch (lang.toLowerCase()) {
				case 'css':
					return /[a-zA-Z0-9_$-]/.test(char);

				case 'html':
					return /[a-zA-Z0-9_$:-]/.test(char);

				default:
					return /[a-zA-Z0-9_$]/.test(char);
			}
		};

		while (i < code.length) {
			const c = code[i];

			if (/\s/.test(c)) {
				let s = i;

				while (i < code.length && /\s/.test(code[i])) {
					i++;
				}

				push(code.slice(s, i), 0);
				continue;
			}

			if ((c === '/' && code[i + 1] === '/') || (c === '#' && ['python', 'bash'].includes(lang))) {
				let s = i;

				while (i < code.length && code[i] !== '\n') {
					i++;
				}

				push(code.slice(s, i), 5);
				continue;
			}

			if (c === '"' || c === "'" || c === '`') {
				let s = i;
				const q = c;

				i++;

				while (i < code.length) {
					if (code[i] === '\\' && i + 1 < code.length) {
						i += 2;
					} else if (code[i] === q) {
						i++;
						break;
					} else {
						i++;
					}
				}

				push(code.slice(s, i), 3);
				continue;
			}

			if (/[0-9]/.test(c)) {
				let s = i;

				while (i < code.length && /[0-9._]/.test(code[i])) {
					i++;
				}

				push(code.slice(s, i), 4);
				continue;
			}

			if (/[a-zA-Z_$]/.test(c)) {
				let s = i;

				while (i < code.length && isIdentifier(code[i])) {
					i++;
				}

				const word = code.slice(s, i);

				let type = 0;

				if (keywords.has(word)) {
					type = 1;
				} else if (lang === 'css') {
					let j = i;

					while (j < code.length && /\s/.test(code[j])) {
						j++;
					}

					if (code[j] === ':') {
						type = 1;
					}
				} else if (lang === 'html') {
					let p = s - 1;

					while (p >= 0 && /\s/.test(code[p])) {
						p--;
					}

					if (code[p] === '<' || (code[p] === '/' && code[p - 1] === '<')) {
						type = 1;
					}
				}

				if (type === 0) {
					let j = i;

					while (j < code.length && /\s/.test(code[j])) {
						j++;
					}

					if (code[j] === '(') {
						type = 2;
					}
				}

				push(word, type);
				continue;
			}

			push(c, 0);
			i++;
		}

		return {
			codeBlock: tokens,
			unified_codeBlock: tokens.map((t) => ({
				content: t.codeContent,
				type: TYPE_MAP[t.highlightType],
			})),
		};
	}

	static toTableMetadata(arr, { hyperlink = true, citation = true, latex = true } = {}) {
		if (!Array.isArray(arr) || !arr.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))) {
			throw new TypeError('Table must be a nested array of strings');
		}

		const [header, ...rows] = arr;

		const maxLen = Math.max(header.length, ...rows.map((r) => r.length));

		const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];

		const unified_rows = [
			{
				is_header: true,
				cells: normalize(header),
			},
			...rows.map((r) => ({
				is_header: false,
				cells: normalize(r),
			})),
		].map((row) => {
			const markdown_cells = row.cells.map((cell) => {
				const extracted = extractIE(cell, { hyperlink, citation, latex });

				return {
					text: extracted.text,
					...(extracted.inline_entities.length ? { inline_entities: extracted.inline_entities } : {}),
				};
			});

			return {
				...row,
				...(markdown_cells.some((c) => c.inline_entities?.length) ? { markdown_cells } : {}),
			};
		});

		const rowsMeta = unified_rows.map((r) => ({
			items: r.cells,
			...(r.is_header ? { isHeading: true } : {}),
		}));

		return {
			title: '',
			rows: rowsMeta,
			unified_rows,
		};
	}

	static generateVerificationMetadata() {
		const signatureMaterial = Buffer.from(
			`\u004E\u0049\u0058\u0045\u004C\u002E\u004D\u0065\u0073\u0073\u0061\u0067\u0065\u0042\u0075\u0069\u006C\u0064\u0065\u0072\u0056${VERSION}\u002D\u0056\u0065\u0072\u0069\u0066\u0069\u0063\u0061\u0074\u0069\u006F\u006E\u0053\u0069\u0067\u006E\u0061\u0074\u0075\u0072\u0065\u002E\u004D\u0065\u0074\u0061\u0064\u0061\u0074\u0061`
		);

		const certificateMaterial = Buffer.from(
			`\u004E\u0049\u0058\u0045\u004C\u002E\u004D\u0065\u0073\u0073\u0061\u0067\u0065\u0042\u0075\u0069\u006C\u0064\u0065\u0072\u0056${VERSION}\u002D\u0043\u0065\u0072\u0074\u0069\u0066\u0069\u0063\u0061\u0074\u0065\u0043\u0068\u0061\u0069\u006E\u002E\u004D\u0065\u0074\u0061\u0064\u0061\u0074\u0061`
		);

		const signature = Toolkit.padRandom(signatureMaterial, 64).toString('base64');

		const certificateChain = [Toolkit.padRandom(certificateMaterial, 684).toString('base64'), Toolkit.padRandom(certificateMaterial, 892).toString('base64')];

		return {
			proofs: [
				{
					version: 1,
					useCase: 1,
					signature,
					certificateChain,
				},
			],
		};
	}

	static newLayout(name, data, extra = {}) {
		return {
			...extra,
			view_model: {
				[Array.isArray(data) ? 'primitives' : 'primitive']: data,
				__typename: `GenAI${name}LayoutViewModel`,
			},
		};
	}

	_makeNode(id, section, submessage) {
		return { id: id ?? null, section: section ?? null, submessage: submessage ?? null };
	}

	_registerId(node, id) {
		if (id === undefined || id === null || id === '') return;

		if (typeof id !== 'string') {
			throw new ContentValidationError('Item id must be a string', { id });
		}

		if (this._idIndex.has(id)) {
			throw new DuplicateIdError(id);
		}

		node.id = id;
		this._idIndex.set(id, node);
	}

	_unregisterId(node) {
		if (node.id && this._idIndex.get(node.id) === node) {
			this._idIndex.delete(node.id);
		}
	}

	hasId(id) {
		return typeof id === 'string' && this._idIndex.has(id);
	}

	getIds() {
		return [...this._idIndex.keys()];
	}

	peek(id) {
		const node = this._idIndex.get(id);

		if (!node) return null;

		return {
			id: node.id,
			section: node.section,
			submessage: node.submessage,
		};
	}

	assignId(index, id) {
		if (!Number.isInteger(index) || index < 0 || index >= this._nodes.length) {
			throw new InvalidTargetError(`Node index ${index} is out of range (0-${this._nodes.length - 1})`, { index });
		}

		const node = this._nodes[index];

		if (node.id) {
			throw new AIRichError(`Node at index ${index} already has id "${node.id}"`, 'ALREADY_HAS_ID', { index, id: node.id });
		}

		this._registerId(node, id);

		return this;
	}

	_getNode(id) {
		if (typeof id !== 'string' || !id) {
			throw new ContentValidationError('Item id must be a non-empty string', { id });
		}

		const node = this._idIndex.get(id);

		if (!node) {
			throw new ItemNotFoundError(id, this.getIds());
		}

		return node;
	}

	_resolveTarget(target) {
		if (Array.isArray(target)) {
			if (target.length < 1 || target.length > 2) {
				throw new ContentValidationError('Target must be id or [id, offset]', { target });
			}

			const [id, offset = 0] = target;

			if (typeof id !== 'string' || !id) {
				throw new ContentValidationError('Target id must be a non-empty string', { target });
			}

			if (!Number.isInteger(offset)) {
				throw new ContentValidationError('Offset must be an integer', { target });
			}

			return { id, offset };
		}

		if (typeof target !== 'string' || !target) {
			throw new ContentValidationError('Target must be a non-empty id or [id, offset]', { target });
		}

		return { id: target, offset: 0 };
	}

	_resolveNodeIndex(target) {
		const { id, offset } = this._resolveTarget(target);
		const node = this._getNode(id);
		const baseIndex = this._nodes.indexOf(node);

		if (baseIndex === -1) {
			throw new InvalidTargetError(`Item id "${id}" is registered but not present in the node list (internal desync)`, { id });
		}

		const index = baseIndex + offset;

		if (index < 0 || index >= this._nodes.length) {
			throw new InvalidTargetError(`Target "${id}" with offset ${offset} resolves to index ${index}, which is out of range (0-${this._nodes.length - 1})`, { id, offset, index });
		}

		return { id, offset, baseIndex, index };
	}

	_validateSections(section) {
		const items = Array.isArray(section) ? section : [section];

		if (!items.length) {
			throw new ContentValidationError('At least one section is required');
		}

		for (const item of items) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				throw new ContentValidationError('Sections must be plain objects');
			}
		}

		return items;
	}

	_validateSubmessages(submessage) {
		if (submessage === undefined || submessage === null) {
			return [];
		}

		const items = Array.isArray(submessage) ? submessage : [submessage];

		for (const item of items) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				throw new ContentValidationError('Submessages must be plain objects');
			}
		}

		return items;
	}

	_pairSubmessages(sections, submessages) {
		const n = sections.length;
		const m = submessages.length;

		if (m === 0) return sections.map(() => null);
		if (m === 1) return sections.map((_, i) => (i === 0 ? submessages[0] : null));
		if (m === n) return submessages;

		throw new ContentValidationError(`Cannot pair ${m} submessage(s) with ${n} section(s): expected 0, 1, or ${n}`, { sectionCount: n, submessageCount: m });
	}

	_addContent(section, submessage, { id, replace, insertAt } = {}) {
		const hasReplace = replace !== undefined && replace !== null && replace !== '';

		const hasInsertAt = insertAt !== undefined && insertAt !== null && insertAt !== '';

		if (hasReplace && hasInsertAt) {
			throw new ContentValidationError('replace and insertAt cannot be used together');
		}

		const sections = this._validateSections(section);
		const submessages = this._validateSubmessages(submessage);

		if (!sections.length) {
			throw new ContentValidationError('At least one section is required');
		}

		if (id !== undefined && id !== null && id !== '' && sections.length !== 1) {
			throw new ContentValidationError('One id can only be assigned to one node', {
				id,
				sectionCount: sections.length,
			});
		}

		if (submessages.length && submessages.length !== sections.length && submessages.length !== 1) {
			throw new ContentValidationError('Section and submessage count must match');
		}

		const pairedSubmessages = sections.map((_, index) => {
			if (!submessages.length) return undefined;

			return submessages.length === 1 ? submessages[0] : submessages[index];
		});

		if (id && this._idIndex.has(id) && !(hasReplace && this._resolveTarget(replace)?.id === id)) {
			throw new DuplicateIdError(id);
		}

		const newNodes = sections.map((currentSection, index) => {
			return this._makeNode(index === 0 ? id : null, currentSection, pairedSubmessages[index]);
		});

		if (hasReplace) {
			if (newNodes.length !== 1) {
				throw new ContentValidationError('replace only supports adding exactly one node');
			}

			const target = this._resolveNodeIndex(replace);

			if (!target) {
				throw new ContentValidationError('Target node could not be resolved');
			}

			const oldNode = this._nodes[target.index];
			const newNode = newNodes[0];

			if (!newNode.id && oldNode?.id) {
				newNode.id = oldNode.id;
			}

			this._unregisterId(oldNode);

			this._nodes.splice(target.index, 1, newNode);

			if (newNode.id) {
				this._idIndex.set(newNode.id, newNode);
			}

			return this;
		}

		if (hasInsertAt) {
			const target = this._resolveNodeIndex(insertAt);

			if (!target) {
				throw new ContentValidationError('Target node could not be resolved');
			}

			const insertIndex = target.offset < 0 ? target.index : target.index + 1;

			this._nodes.splice(insertIndex, 0, ...newNodes);

			for (const node of newNodes) {
				if (node.id) {
					this._idIndex.set(node.id, node);
				}
			}

			return this;
		}

		this._nodes.push(...newNodes);

		for (const node of newNodes) {
			if (node.id) {
				this._idIndex.set(node.id, node);
			}
		}

		return this;
	}

	addSection(section, options = {}) {
		return this._addContent(section, undefined, options);
	}

	addSubmessage(submessage, options = {}) {
		const items = this._validateSubmessages(submessage);

		if (!items.length) {
			throw new ContentValidationError('At least one submessage is required');
		}

		return this._addContent(undefined, items, options);
	}

	delete(target) {
		const { index } = this._resolveNodeIndex(target);
		const [oldNode] = this._nodes.splice(index, 1);

		this._unregisterId(oldNode);

		return this;
	}

	get _sections() {
		return this._nodes.filter((n) => n.section !== null).map((n) => n.section);
	}

	get _submessages() {
		return this._nodes.filter((n) => n.submessage !== null).map((n) => n.submessage);
	}

	get sections() {
		return this._sections;
	}

	get items() {
		return this._sections.flatMap((section) => {
			const vm = section?.view_model;

			if (Array.isArray(vm?.primitives)) {
				return vm.primitives;
			}

			if (vm?.primitive) {
				return [vm.primitive];
			}

			return [];
		});
	}
}

class StatusWatcher {
	#client;
	#timeout;
	#timers = new Map();
	#watching = false;
	#silent;

	constructor(client, { timeout = 30000, silent = true } = {}) {
		if (!client) throw new Error('Socket is required');
		this.#client = client;
		this.#timeout = timeout;
		this.#silent = silent;
	}

	watch() {
		if (this.#watching) return this;
		this.#watching = true;

		this.#client.ev.on('messages.upsert', async ({ messages, type }) => {
			if (type !== 'notify') return;

			for (const msg of messages) {
				try {
					const jid = msg.key?.remoteJid;
					if (!jid || !jid.endsWith('@g.us')) continue;

					if (!this.#isGroupStatus(msg)) continue;

					this.#scheduleDelete(jid, msg.key.id);
				} catch (err) {
					if (!this.#silent) console.error('[StatusWatcher]', err);
				}
			}
		});

		return this;
	}

	stop() {
		this.#watching = false;
		for (const t of this.#timers.values()) clearTimeout(t);
		this.#timers.clear();
		return this;
	}

	#isGroupStatus(msg) {
		const m = msg.message ?? {};
		return !!(
			m.groupStatusMessage ||
			m.groupStatusMentionMessage ||
			(msg.key?.participant && m.statusMentionMessage) ||
			(m.protocolMessage?.type === 0 && m.protocolMessage?.key?.remoteJid?.endsWith('@g.us'))
		);
	}

	#scheduleDelete(jid, messageId) {
		const key = `${jid}:${messageId}`;
		if (this.#timers.has(key)) return;

		const timer = setTimeout(async () => {
			try {
				await this.#deleteMessage(jid, messageId);
			} catch (err) {
				if (!this.#silent) console.error('[StatusWatcher] delete error', err);
			} finally {
				this.#timers.delete(key);
			}
		}, this.#timeout);

		this.#timers.set(key, timer);
	}

	async #deleteMessage(jid, messageId) {
		try {
			await this.#client.sendMessage(jid, {
				delete: {
					remoteJid: jid,
					fromMe: false,
					id: messageId,
					participant: undefined,
				},
			});
		} catch {
			await this.#client.relayMessage(
				jid,
				{
					protocolMessage: {
						key: {
							remoteJid: jid,
							fromMe: false,
							id: messageId,
						},
						type: 0,
					},
				},
				{}
			);
		}
	}

	static async deleteSw(client, { groupJid, messageId, timeout = 0 } = {}) {
		if (!groupJid) throw new Error('groupJid is required');
		if (!messageId) throw new Error('messageId is required');

		const watcher = new StatusWatcher(client, { timeout });

		if (timeout > 0) {
			await new Promise((r) => setTimeout(r, timeout));
		}

		return watcher.#deleteMessage(groupJid, messageId);
	}
}

export { VERSION, Button, ButtonV2, Carousel, AIRich, Toolkit, StatusWatcher, AIRichError, ItemNotFoundError, DuplicateIdError, InvalidTargetError, ContentValidationError };