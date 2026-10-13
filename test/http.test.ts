import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KudePendienteError,
  Sifende,
  SifendeApiError,
  SifendeConexionError,
  SifendeError,
  SifendeTimeoutError,
} from '../src/index.js';

// Casos que sólo se ven con un servidor HTTP real y el fetch nativo: el cuerpo llega después de los headers.

type Manejador = (req: IncomingMessage, res: ServerResponse, numero: number) => void;

const servidores: { close(): void; closeAllConnections(): void }[] = [];

afterEach(() => {
  for (const servidor of servidores.splice(0)) {
    servidor.closeAllConnections();
    servidor.close();
  }
});

async function servidor(manejar: Manejador) {
  const solicitudes: { headers: IncomingMessage['headers']; cuerpo: string }[] = [];
  const http = createServer(async (req, res) => {
    let cuerpo = '';
    for await (const parte of req) cuerpo += parte;
    solicitudes.push({ headers: req.headers, cuerpo });
    manejar(req, res, solicitudes.length);
  });
  servidores.push(http);
  await new Promise<void>((resolver) => http.listen(0, '127.0.0.1', resolver));
  return { baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, solicitudes };
}

const cortarCuerpo = (res: ServerResponse) => {
  res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': '200' });
  res.write('{"cdc":"01');
  setTimeout(() => res.destroy(), 5);
};

const responder = (res: ServerResponse, status: number, cuerpo: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(cuerpo));

const factura = {
  tipoDocumento: 'FACTURA_ELECTRONICA',
  items: [{ codigo: 'P1', descripcion: 'Remera', cantidad: 1, precioUnitario: 150000 }],
} as unknown as Parameters<Sifende['documentos']['emitir']>[0];

describe('lectura del cuerpo', () => {
  it('reintenta con la misma clave si la conexión se corta mientras llega el cuerpo', async () => {
    const { baseUrl, solicitudes } = await servidor((_, res, numero) =>
      numero === 1 ? cortarCuerpo(res) : responder(res, 202, { cdc: '0180', estado: 'PENDIENTE' }),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl, maxReintentos: 1 });

    const respuesta = await sifende.documentos.emitir(factura, { idempotencyKey: 'corte-1' });

    expect(respuesta.cdc).toBe('0180');
    expect(solicitudes.map((s) => s.headers['idempotency-key'])).toEqual(['corte-1', 'corte-1']);
  });

  it('informa la clave en un SifendeConexionError si el cuerpo se corta en el último intento', async () => {
    const { baseUrl } = await servidor((_, res) => cortarCuerpo(res));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl, maxReintentos: 0 });

    const error = await sifende.documentos.emitir(factura, { idempotencyKey: 'corte-2' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SifendeConexionError);
    expect((error as SifendeConexionError).idempotencyKey).toBe('corte-2');
  });

  it('convierte en SifendeTimeoutError un cuerpo que no termina de llegar', async () => {
    const { baseUrl } = await servidor((_, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.write('{"cdc":');
    });
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl, timeoutMs: 50, maxReintentos: 0 });

    const error = await sifende.documentos.emitir(factura, { idempotencyKey: 'lento' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SifendeTimeoutError);
    expect((error as SifendeTimeoutError).idempotencyKey).toBe('lento');
  });

  it('no devuelve como éxito un JSON que no se puede leer', async () => {
    const { baseUrl } = await servidor((_, res) =>
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"cdc":'),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl, maxReintentos: 0 });

    const resultado = await sifende.documentos.emitir(factura, { idempotencyKey: 'roto' }).then(
      (datos) => ({ datos }),
      (error: unknown) => ({ error }),
    );

    expect(resultado).not.toHaveProperty('datos');
    expect((resultado as { error: SifendeConexionError }).error).toBeInstanceOf(SifendeConexionError);
    expect((resultado as { error: SifendeConexionError }).error.idempotencyKey).toBe('roto');
  });
});

describe('reintentos', () => {
  it('envía el mismo cuerpo en cada intento aunque el objeto cambie entre medio', async () => {
    const item = { codigo: 'P1', descripcion: 'Remera', cantidad: 1, precioUnitario: 150000 };
    const documento = { tipoDocumento: 'FACTURA_ELECTRONICA', items: [item] };
    const { baseUrl, solicitudes } = await servidor((_, res, numero) => {
      if (numero === 1) {
        item.precioUnitario = 999;
        return res.destroy();
      }
      responder(res, 202, { cdc: '0180' });
    });
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl, maxReintentos: 1 });

    await sifende.documentos.emitir(documento as never, { idempotencyKey: 'mutable' });

    expect(solicitudes).toHaveLength(2);
    expect(solicitudes[1]?.cuerpo).toBe(solicitudes[0]?.cuerpo);
  });

  it('reintenta un 500 en una consulta, como promete el README', async () => {
    const { baseUrl, solicitudes } = await servidor((_, res, numero) =>
      numero === 1
        ? responder(res, 500, { type: 'https://sifende.com.py/problemas/internal-error' }, { 'Retry-After': '0' })
        : responder(res, 200, { estado: 'APROBADO' }),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl, maxReintentos: 2 });

    const estado = await sifende.documentos.consultarEstado('0180');

    expect(estado.estado).toBe('APROBADO');
    expect(solicitudes).toHaveLength(2);
  });
});

describe('errores de la API', () => {
  it('mantiene el SifendeApiError aunque el Problem Details traiga un type que no es texto', async () => {
    const { baseUrl } = await servidor((_, res) =>
      responder(res, 400, { type: 17, title: 'Error' }, { 'Content-Type': 'application/problem+json' }),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl });

    const error = await sifende.documentos.emitir(factura, { idempotencyKey: 'tipo' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SifendeApiError);
    expect((error as SifendeApiError).status).toBe(400);
    expect((error as SifendeApiError).idempotencyKey).toBe('tipo');
    expect((error as SifendeApiError).codigo).toBeUndefined();
  });
});

describe('configuración', () => {
  it('rechaza al construir un timeout inválido en vez de tratarlo como falla de conexión', () => {
    expect(() => new Sifende({ apiKey: 'sk_test_abc', timeoutMs: -1 })).toThrow(RangeError);
    expect(() => new Sifende({ apiKey: 'sk_test_abc', maxReintentos: -1 })).toThrow(RangeError);
  });

  it('rechaza al construir una baseUrl inválida', () => {
    expect(() => new Sifende({ apiKey: 'sk_test_abc', baseUrl: 'no es una url' })).toThrow(TypeError);
  });
});

describe('plazo del KuDE', () => {
  it('respeta esperarMs también durante los reintentos HTTP de la preparación', async () => {
    const { baseUrl, solicitudes } = await servidor((_, res, numero) => {
      if (numero === 1) return responder(res, 202, { estado: 'PENDIENTE' }, { 'Retry-After': '0' });
      if (numero === 2) return responder(res, 503, { type: 'x/kude-unavailable' }, { 'Retry-After': '0.2' });
      res.writeHead(200, { 'Content-Type': 'application/pdf' }).end('%PDF');
    });
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl });

    const inicio = Date.now();
    const error = await sifende.documentos.descargarKude('0180', { esperarMs: 50 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KudePendienteError);
    expect(Date.now() - inicio).toBeLessThan(150);
    expect(solicitudes).toHaveLength(2);
  });

  it('respeta esperarMs aunque el servidor tarde en entregar el PDF', async () => {
    const { baseUrl } = await servidor((_, res) => {
      setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/pdf' }).end('%PDF'), 300);
    });
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl });

    const inicio = Date.now();
    const error = await sifende.documentos.descargarKude('0180', { esperarMs: 50 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KudePendienteError);
    expect(Date.now() - inicio).toBeLessThan(200);
  });

  it('distingue la cancelación del consumidor del plazo vencido', async () => {
    const { baseUrl } = await servidor(() => {});
    const sifende = new Sifende({ apiKey: 'sk_test_abc', baseUrl });
    const controlador = new AbortController();
    setTimeout(() => controlador.abort(new Error('cancelado')), 20);

    const error = await sifende.documentos
      .descargarKude('0180', { esperarMs: 5_000, signal: controlador.signal })
      .catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(SifendeError);
    expect((error as Error).message).toBe('cancelado');
  });
});
