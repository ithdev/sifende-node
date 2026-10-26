import { describe, expect, it } from 'vitest';
import {
  KudePendienteError,
  Sifende,
  SifendeApiError,
  SifendeConexionError,
  SifendeTimeoutError,
  VERSION,
} from '../src/index.js';

type Llamada = { url: URL; init: RequestInit; headers: Headers };
type Respondedor = (llamada: Llamada) => Response | Promise<Response>;

function falsoFetch(...respuestas: Respondedor[]) {
  const llamadas: Llamada[] = [];
  const fetch = async (entrada: RequestInfo | URL, init: RequestInit = {}) => {
    const llamada = { url: new URL(String(entrada)), init, headers: new Headers(init.headers) };
    llamadas.push(llamada);
    const respondedor = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
    if (!respondedor) throw new Error('sin respuesta configurada');
    return respondedor(llamada);
  };
  return { fetch: fetch as typeof globalThis.fetch, llamadas };
}

const json =
  (cuerpo: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const problema = (
  status: number,
  codigo: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  json(
    {
      type: `https://sifende.com.py/docs/solucion-problemas/${codigo}`,
      title: 'Título',
      status,
      detail: 'Detalle',
      ...extra,
    },
    status,
    { 'Content-Type': 'application/problem+json', ...headers },
  );

const factura = {
  tipoDocumento: 'FACTURA_ELECTRONICA',
  tipoEmision: 'NORMAL',
  numeroEstablecimiento: 1,
  puntoExpedicion: 1,
  tipoTransaccion: 'VENTA_MERCADERIA',
  receptor: {
    tipoContribuyente: 'NO_CONTRIBUYENTE',
    tipoOperacion: 'B2C',
    tipoDocumento: 'INNOMINADO',
    numeroDocumento: '0',
    nombreRazonSocial: 'Sin Nombre',
  },
  items: [
    {
      codigo: 'P1',
      descripcion: 'Remera',
      cantidad: 1,
      precioUnitario: 150000,
      afectacionTributaria: 'GRAVADO',
      tasaIVA: 10,
    },
  ],
} as Parameters<Sifende['documentos']['emitir']>[0];

describe('Sifende', () => {
  it('detecta el ambiente por el prefijo de la API key', () => {
    expect(new Sifende({ apiKey: 'sk_live_abc' }).ambiente).toBe('PROD');
    expect(new Sifende({ apiKey: 'sk_test_abc' }).ambiente).toBe('DEV');
    expect(new Sifende({ apiKey: 'sk_sandbox_abc' }).ambiente).toBe('SANDBOX');
  });

  it('exige una API key', () => {
    expect(() => new Sifende({ apiKey: ' ' })).toThrow(TypeError);
  });
});

describe('documentos.emitir', () => {
  it('envía la API key, el cuerpo y una Idempotency-Key generada', async () => {
    const { fetch, llamadas } = falsoFetch(json({ cdc: '0180', estado: 'PENDIENTE' }, 202));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const respuesta = await sifende.documentos.emitir(factura);

    expect(respuesta.cdc).toBe('0180');
    const [llamada] = llamadas;
    expect(llamada?.url.toString()).toBe('https://api.sifende.com.py/api/v1/documento-electronico');
    expect(llamada?.init.method).toBe('POST');
    expect(llamada?.headers.get('authorization')).toBe('Bearer sk_test_abc');
    expect(llamada?.headers.get('user-agent')).toBe(`sifende-sdk-ts/${VERSION}`);
    expect(llamada?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(llamada?.init.body))).toEqual(factura);
  });

  it('usa la Idempotency-Key indicada y la repite al reintentar', async () => {
    const { fetch, llamadas } = falsoFetch(
      () => {
        throw new TypeError('fetch failed');
      },
      problema(409, 'idempotency-in-progress', {}, { 'Retry-After': '0' }),
      json({ cdc: '0180' }, 202),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch, maxReintentos: 3 });

    await sifende.documentos.emitir(factura, { idempotencyKey: 'pedido-1001' });

    expect(llamadas).toHaveLength(3);
    expect(llamadas.map((l) => l.headers.get('idempotency-key'))).toEqual([
      'pedido-1001',
      'pedido-1001',
      'pedido-1001',
    ]);
  });

  it('convierte un Problem Details en SifendeApiError con código y errores por campo', async () => {
    const { fetch } = falsoFetch(
      problema(400, 'validation-error', {
        errores: { 'receptor.digitoVerificador': 'Obligatorio' },
        traceId: 'abc123',
      }),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const error = await sifende.documentos.emitir(factura, { idempotencyKey: 'k1' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SifendeApiError);
    const apiError = error as SifendeApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.codigo).toBe('validation-error');
    expect(apiError.errores).toEqual({ 'receptor.digitoVerificador': 'Obligatorio' });
    expect(apiError.traceId).toBe('abc123');
    expect(apiError.idempotencyKey).toBe('k1');
  });

  it('no reintenta un 500 en una emisión', async () => {
    const { fetch, llamadas } = falsoFetch(problema(500, 'internal-error'));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.documentos.emitir(factura)).rejects.toBeInstanceOf(SifendeApiError);
    expect(llamadas).toHaveLength(1);
  });

  it('informa la clave usada cuando se agotan los reintentos de conexión', async () => {
    const { fetch } = falsoFetch(() => {
      throw new TypeError('fetch failed');
    });
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch, maxReintentos: 0 });

    const error = await sifende.documentos.emitir(factura, { idempotencyKey: 'k2' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SifendeConexionError);
    expect((error as SifendeConexionError).idempotencyKey).toBe('k2');
  });

  it('corta por timeout con SifendeTimeoutError', async () => {
    const { fetch } = falsoFetch(
      ({ init }) =>
        new Promise((_, rechazar) => init.signal?.addEventListener('abort', () => rechazar(init.signal?.reason))),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch, timeoutMs: 20, maxReintentos: 0 });

    await expect(sifende.documentos.emitir(factura)).rejects.toBeInstanceOf(SifendeTimeoutError);
  });
});

describe('consultas', () => {
  it('reintenta un GET ante un 503 y codifica el CDC', async () => {
    const { fetch, llamadas } = falsoFetch(
      problema(503, 'internal-error', {}, { 'Retry-After': '0' }),
      json({ estado: 'APROBADO' }),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const estado = await sifende.documentos.consultarEstado('0180/x');

    expect(estado.estado).toBe('APROBADO');
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0]?.url.pathname).toBe('/api/v1/documento-electronico/status/0180%2Fx');
  });

  it('devuelve el contenido de data en el padrón', async () => {
    const { fetch } = falsoFetch(json({ data: { nombreRazonSocial: 'ACME S.A.' }, timestamp: 'x', errors: [] }));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.padron.consultar('80012345-6')).resolves.toEqual({ nombreRazonSocial: 'ACME S.A.' });
  });

  it('consulta los catálogos públicos sin API key', async () => {
    const { fetch, llamadas } = falsoFetch(json({ tipoPago: [{ name: 'EFECTIVO', val: 1 }] }));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch, baseUrl: 'http://localhost:8080/' });

    await sifende.catalogos.enumeraciones();

    expect(llamadas[0]?.url.toString()).toBe('http://localhost:8080/api/v1/public/enums');
    expect(llamadas[0]?.headers.has('authorization')).toBe(false);
  });

  it('pasa los filtros de eventos como query', async () => {
    const { fetch, llamadas } = falsoFetch(json({ content: [], page: 1 }));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await sifende.documentos.listarEventos({ page: 1, size: 20, tipoEvento: 'CANCELACION' });

    expect(llamadas[0]?.url.search).toBe('?page=1&size=20&tipoEvento=CANCELACION');
  });
});

describe('documentos.descargarKude', () => {
  const pdf = () =>
    new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { 'Content-Type': 'application/pdf' } });

  it('espera mientras el KuDE se prepara y consulta con soloConsulta', async () => {
    const { fetch, llamadas } = falsoFetch(json({ estado: 'PENDIENTE', url: null }, 202, { 'Retry-After': '0' }), pdf);
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const contenido = await sifende.documentos.descargarKude('0180');

    expect(Array.from(contenido)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(llamadas[0]?.url.search).toBe('');
    expect(llamadas[1]?.url.search).toBe('?soloConsulta=true');
  });

  it('lanza KudePendienteError si no está listo dentro de la espera', async () => {
    const { fetch } = falsoFetch(json({ estado: 'PENDIENTE', url: null }, 202, { 'Retry-After': '5' }));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.documentos.descargarKude('0180', { esperarMs: 1000 })).rejects.toBeInstanceOf(
      KudePendienteError,
    );
  });
});

describe('eventos', () => {
  it('cancela con motivo e Idempotency-Key', async () => {
    const { fetch, llamadas } = falsoFetch(json({ estadoEvento: 'APROBADO' }));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await sifende.documentos.cancelar('0180', { motivo: 'Pedido cancelado por el cliente' });

    expect(llamadas[0]?.url.pathname).toBe('/api/v1/documento-electronico/0180/cancelar');
    expect(llamadas[0]?.headers.has('idempotency-key')).toBe(true);
  });

  it('reintenta la nominación ante 503 evento-nominacion-error', async () => {
    const { fetch, llamadas } = falsoFetch(
      problema(503, 'evento-nominacion-error', {}, { 'Retry-After': '0' }),
      json({ estadoEvento: 'APROBADO' }),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const evento = await sifende.documentos.nominar('0180', {
      motivo: 'Identificación del cliente a su solicitud',
      receptor: {
        naturaleza: 'NO_CONTRIBUYENTE',
        tipoOperacion: 'B2C',
        pais: 'PRY',
        tipoDocumento: 'CEDULA_PARAGUAYA',
        numeroDocumento: '1234567',
        nombreRazonSocial: 'Juan Pérez',
      },
    });

    expect(evento.estadoEvento).toBe('APROBADO');
    expect(llamadas[0]?.headers.get('idempotency-key')).toBe(llamadas[1]?.headers.get('idempotency-key'));
  });
});

describe('descargas', () => {
  const bytes = (tipo: string, contenido: Uint8Array<ArrayBuffer> | string) => () =>
    new Response(contenido, { headers: { 'Content-Type': tipo } });

  it('devuelve el XML firmado como texto y lo pide como XML', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><rDE><DE Id="0180"/></rDE>';
    const { fetch, llamadas } = falsoFetch(bytes('application/xml', xml));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.documentos.descargarXml('0180')).resolves.toBe(xml);
    expect(llamadas[0]?.url.pathname).toBe('/api/v1/documento-electronico/0180/xml');
    expect(llamadas[0]?.headers.get('accept')).toMatch(/^application\/xml/);
  });

  it('informa el 409 de un documento que todavía no tiene XML', async () => {
    const { fetch } = falsoFetch(problema(409, 'documento-xml-not-available'));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const error = await sifende.documentos.descargarXml('0180').catch((e: unknown) => e);

    expect((error as SifendeApiError).codigo).toBe('documento-xml-not-available');
  });

  it('descarga el ticket con ancho y resumen sólo si se indican', async () => {
    const { fetch, llamadas } = falsoFetch(bytes('application/pdf', '%PDF'));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await sifende.documentos.descargarKudeTicket('0180');
    const contenido = await sifende.documentos.descargarKudeTicket('0180', { ancho: 58, resumen: true });

    expect(new TextDecoder().decode(contenido)).toBe('%PDF');
    expect(llamadas[0]?.url.pathname).toBe('/api/v1/documento-electronico/0180/kude/ticket');
    expect(llamadas[0]?.url.search).toBe('');
    expect(llamadas[1]?.url.search).toBe('?ancho=58&resumen=true');
  });

  it('no reintenta el 501 de un tipo de documento sin ticket', async () => {
    const { fetch, llamadas } = falsoFetch(problema(501, 'kude-not-supported'));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.documentos.descargarKudeTicket('0180')).rejects.toBeInstanceOf(SifendeApiError);
    expect(llamadas).toHaveLength(1);
  });

  it('descarga el ticket como PNG para ESC/POS', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { fetch, llamadas } = falsoFetch(bytes('image/png', png));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const contenido = await sifende.documentos.descargarKudeTicketImagen('0180', { puntos: 384 });

    expect(Array.from(contenido)).toEqual(Array.from(png));
    expect(llamadas[0]?.url.pathname).toBe('/api/v1/documento-electronico/0180/kude/ticket/imagen');
    expect(llamadas[0]?.url.search).toBe('?puntos=384');
    expect(llamadas[0]?.headers.get('accept')).toMatch(/^image\/png/);
  });

  it('lista las ciudades de un departamento sin API key', async () => {
    const { fetch, llamadas } = falsoFetch(json({ data: [{ ciudadId: 1, nombre: 'ASUNCION (DISTRITO)' }] }));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.catalogos.ciudadesDeDepartamento(1)).resolves.toEqual([
      { ciudadId: 1, nombre: 'ASUNCION (DISTRITO)' },
    ]);
    expect(llamadas[0]?.url.pathname).toBe('/api/v1/geografia/departamentos/1/ciudades');
    expect(llamadas[0]?.headers.has('authorization')).toBe(false);
  });
});

describe('webhooks', () => {
  const cortar = () => {
    throw new TypeError('fetch failed');
  };

  it('crea un webhook sin Idempotency-Key y devuelve el secreto', async () => {
    const { fetch, llamadas } = falsoFetch(json({ endpoint: { id: 7 }, secreto: 'whsec_nuevo' }, 201));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const creado = await sifende.webhooks.crear({
      url: 'https://tienda.com.py/webhooks/sifende',
      eventos: ['documento.aprobado', 'documento.rechazado'],
    });

    expect(creado.secreto).toBe('whsec_nuevo');
    expect(llamadas[0]?.init.method).toBe('POST');
    expect(llamadas[0]?.url.pathname).toBe('/api/v1/contribuyente/webhooks');
    expect(llamadas[0]?.headers.has('idempotency-key')).toBe(false);
  });

  it('no repite la creación ni la rotación tras un corte de conexión', async () => {
    const { fetch, llamadas } = falsoFetch(cortar, json({ secreto: 'whsec_duplicado' }, 201));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.webhooks.crear({ url: 'https://tienda.com.py/w', eventos: [] })).rejects.toBeInstanceOf(
      SifendeConexionError,
    );
    expect(llamadas).toHaveLength(1);

    const rotacion = falsoFetch(cortar, json({ secreto: 'whsec_otro' }));
    const otro = new Sifende({ apiKey: 'sk_test_abc', fetch: rotacion.fetch });
    await expect(otro.webhooks.rotarSecreto(7)).rejects.toBeInstanceOf(SifendeConexionError);
    expect(rotacion.llamadas).toHaveLength(1);
    expect(rotacion.llamadas[0]?.url.pathname).toBe('/api/v1/contribuyente/webhooks/7/rotar');
  });

  it('lista, consulta, actualiza y elimina', async () => {
    const { fetch, llamadas } = falsoFetch(
      json([{ id: 7, ambiente: 'DEV' }]),
      json({ id: 7 }),
      json({ id: 7, activo: false }),
      () => new Response(null, { status: 204 }),
    );
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    await expect(sifende.webhooks.listar()).resolves.toEqual([{ id: 7, ambiente: 'DEV' }]);
    await sifende.webhooks.consultar(7);
    await sifende.webhooks.actualizar(7, {
      url: 'https://tienda.com.py/w',
      eventos: ['lote.procesado'],
      activo: false,
    });
    await expect(sifende.webhooks.eliminar(7)).resolves.toBeUndefined();

    expect(llamadas.map((l) => `${l.init.method} ${l.url.pathname}`)).toEqual([
      'GET /api/v1/contribuyente/webhooks',
      'GET /api/v1/contribuyente/webhooks/7',
      'PUT /api/v1/contribuyente/webhooks/7',
      'DELETE /api/v1/contribuyente/webhooks/7',
    ]);
    expect(JSON.parse(String(llamadas[2]?.init.body))).toMatchObject({ activo: false });
  });

  it('informa el 404 de un webhook de otro ambiente', async () => {
    const { fetch } = falsoFetch(problema(404, 'webhook-not-found'));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const error = await sifende.webhooks.consultar(8).catch((e: unknown) => e);

    expect((error as SifendeApiError).status).toBe(404);
    expect((error as SifendeApiError).codigo).toBe('webhook-not-found');
  });

  it('pasa los filtros de entregas como query', async () => {
    const { fetch, llamadas } = falsoFetch(json({ content: [{ id: 'e1', estado: 'FALLIDA' }], page: 2 }));
    const sifende = new Sifende({ apiKey: 'sk_test_abc', fetch });

    const pagina = await sifende.webhooks.listarEntregas(7, {
      page: 2,
      size: 50,
      estado: 'FALLIDA',
      tipoEvento: 'documento.aprobado',
    });

    expect(pagina.content?.[0]?.estado).toBe('FALLIDA');
    expect(llamadas[0]?.url.pathname).toBe('/api/v1/contribuyente/webhooks/7/entregas');
    expect(llamadas[0]?.url.search).toBe('?page=2&size=50&estado=FALLIDA&tipoEvento=documento.aprobado');
  });
});
