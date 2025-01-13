import { Hono, MiddlewareHandler } from 'hono';
import { systemPrompt } from './prompts';
import { cors } from 'hono/cors';

interface NoteRecord {
	id: number;
	text: string;
}

interface EmbeddingResponse {
	data: number[][];
}

const app = new Hono<{ Bindings: Env }>();

const apiKeyMiddleware = (): MiddlewareHandler<{ Bindings: Env }> => {
	return (c: any, next: () => Promise<void>) => {
		const apiKey = c.req.header('x-api-key');
		if (apiKey && apiKey === c.env.API_KEY) {
			return next();
		}
		return c.text('Unauthorized: Invalid API key', 401);
	};
};

app.use(
	'/*',
	cors({
		origin: '*',
		allowMethods: ['POST', 'OPTIONS'],
		allowHeaders: ['Content-Type'],
		exposeHeaders: ['Content-Type'],
		credentials: true,
	})
);

// Ask llm model a question and get string/stream back
app.post('/', async (c) => {
	const body = await c.req.json();
	const question = body.text as string;
	if (!question) {
		return c.text('Missing question', 400);
	}
	console.log('Question:', question);

	const stream = c.req.query('stream') === 'true';
	console.log('Stream:', stream);

	const embeddings = (await c.env.AI.run('@cf/baai/bge-base-en-v1.5', {
		text: question,
	})) as EmbeddingResponse;
	const vectors = embeddings.data[0];
	const vectorQuery = await c.env.VECTORIZE.query(vectors, { topK: 5 });

	let vecId: string[] | undefined;
	const threshold = 0.45;
	if (vectorQuery.matches && vectorQuery.matches.length > 0 && vectorQuery.matches[0]) {
		vecId = vectorQuery.matches.filter((vec) => vec.score > threshold).map((vec) => vec.id);
		console.log('Matching vector IDs:', vecId.length);
	} else {
		console.log('No matching vector found or vectorQuery.matches is empty');
	}

	let notes: string[] = [];
	if (vecId) {
		console.log('Fetching notes form DB:', vecId);
		const query = `SELECT * FROM mcinfo WHERE id IN (${vecId.join(',')})`;
		const { results } = await c.env.DB.prepare(query).bind().all<NoteRecord>();

		if (results) notes = results.map((vec) => vec.text);
		if (vecId.length !== notes.length) {
			console.log('Mismatch in vector IDs and notes, vecId lenght:', vecId, ', notes lenght:', notes);
		}
	}

	const contextMessage = notes.length ? `Context:\n${notes.map((note) => `- ${note}`).join('\n')}` : '';

	const result = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
		messages: [
			...(notes.length ? [{ role: 'system' as const, content: contextMessage }] : []),
			{ role: 'system' as const, content: systemPrompt },
			{ role: 'user' as const, content: question },
		],
		stream,
		seed: 2828282828,
	});

	if ('response' in result) {
		console.log('Response:', result.response);
		if (result.response) {
			return c.text(result.response);
		}
	} else if (result instanceof ReadableStream) {
		const stream = result.pipeThrough(new SSEToStream()).pipeThrough(new TextEncoderStream());

		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'cache-control': 'no-cache',
				connection: 'keep-alive',
			},
		});
	}

	return c.text('No response or invalid format', 500);
});

// Post array of notes
app.post('/notes', apiKeyMiddleware(), async (c) => {
	try {
		const { texts } = await c.req.json<{ texts: string[] }>();
		if (!Array.isArray(texts) || texts.length === 0) {
			return c.text('Missing or invalid "texts" array', 400);
		}

		const insertQuery = texts.map(() => '(?)').join(', ');
		const { results } = await c.env.DB.prepare(`INSERT INTO mcinfo (text) VALUES ${insertQuery} RETURNING *`)
			.bind(...texts)
			.run<NoteRecord>();

		if (!results || results.length === 0) {
			return c.text('Failed to insert notes', 500);
		}

		const { data } = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', {
			text: texts,
		});

		if (!data || data.length !== texts.length) {
			return c.text('Failed to generate vector embeddings', 500);
		}

		const upserts = results.map((record, index) => ({
			id: record.id.toString(),
			values: data[index],
		}));

		const inserted = await c.env.VECTORIZE.upsert(upserts);

		return c.json({
			insertedRecords: results.map((r) => ({ id: r.id, text: r.text })),
			vectorDbResults: inserted,
		});
	} catch (error) {
		console.error('Error creating note:', error);
		return c.text('Internal server error', 500);
	}
});

// Delete a note by ID
app.delete('/notes/:id', apiKeyMiddleware(), async (c) => {
	const { id } = c.req.param();
	const query = `DELETE FROM mcinfo WHERE id = ?`;
	await c.env.DB.prepare(query).bind(id).run();
	await c.env.VECTORIZE.deleteByIds([id]);

	return c.body(null, 204);
});

// Delete all notes
app.delete('/notes', apiKeyMiddleware(), async (c) => {
	try {
		const selectIdsQuery = `SELECT id FROM mcinfo`;
		const { results } = await c.env.DB.prepare(selectIdsQuery).run<{ id: number }>();

		const ids = results.map((row) => row.id);

		const deleteQuery = `DELETE FROM mcinfo`;
		await c.env.DB.prepare(deleteQuery).run();

		if (ids.length > 0) {
			await c.env.VECTORIZE.deleteByIds(ids.map((id) => id.toString()));
		}

		return c.body(null, 204);
	} catch (error) {
		console.error('Error deleting all notes:', error);
		return c.text('Internal server error', 500);
	}
});

app.onError((err: Error, c) => {
	return c.text(err.toString());
});

class SSEToStream extends TransformStream<Uint8Array, string> {
	private decoder = new TextDecoder();
	private buffer = '';

	constructor() {
		super({
			transform: (chunk: Uint8Array, controller: TransformStreamDefaultController<string>) => this.processChunk(chunk, controller),
			flush: (controller: TransformStreamDefaultController<string>) => controller.enqueue(this.format({ done: true })),
		});
	}

	private processChunk(chunk: Uint8Array, controller: TransformStreamDefaultController<string>): void {
		this.buffer += this.decoder.decode(chunk, { stream: true });

		const lines = this.buffer.split('\n');

		this.buffer = lines.pop() || '';

		lines.forEach((line) => {
			if (line.startsWith('data: ')) {
				const data = line.slice(5).trim();
				try {
					const jsonData = JSON.parse(data);
					controller.enqueue(this.format(jsonData));
				} catch (e) {
					console.warn('Failed to parse JSON:', data);
				}
			}
		});
	}

	private format(payload: Record<string, unknown>): string {
		return JSON.stringify({ done: false, ...payload }) + '\n';
	}
}

export default app;
