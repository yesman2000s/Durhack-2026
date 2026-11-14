export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function jsonRoute({ path, maxBytes, sizeError, timeoutError, unavailableError }, handle) {
  return async (req, res, next) => {
    if (req.url?.split('?')[0] !== path) return next();
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status, error) => {
      if (res.destroyed) return;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error }));
    };
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return fail(405, 'Use POST for this endpoint.');
    }
    if (req.headers.origin && !['http', 'https'].some((scheme) =>
      req.headers.origin === `${scheme}://${req.headers.host}`)) {
      return fail(403, 'Send the request from the camera app origin.');
    }
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return fail(415, 'Send the request as application/json.');
    }

    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBytes) {
          req.resume();
          return fail(413, sizeError);
        }
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail(400, 'Send a valid JSON request.');
      }
      const { contentType, body } = await handle(input, controller.signal);
      if (res.destroyed) return;
      res.setHeader('Content-Type', contentType);
      res.end(body);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message);
      if (error.name === 'TimeoutError') return fail(504, timeoutError);
      return fail(502, unavailableError);
    }
  };
}
