# @sifende/sdk

SDK de Sifende para TypeScript y JavaScript: emití facturas electrónicas, notas de crédito y eventos de SIFEN, verificá
webhooks y calculá totales con las mismas reglas que la API.

- Sin dependencias en runtime: usa `fetch` y Web Crypto nativos (Node 22.18+, Deno, Bun, Cloudflare Workers).
- Tipos generados desde el OpenAPI de la API.
- Reintentos seguros: cada operación tributaria viaja con `Idempotency-Key`.

## Instalación

```bash
npm install @sifende/sdk
```

Necesitás una API key de Sifende. El prefijo de la clave fija el ambiente: `sk_live_`, `sk_test_` o `sk_sandbox_`. La
referencia completa de la API está en [sifende.com.py/docs](https://sifende.com.py/docs).

> La API key emite documentos a nombre del contribuyente: usá el SDK solo en el servidor, nunca en el navegador ni
> dentro de una app distribuida.

## Uso

```ts
import { Sifende, calcularTotales } from '@sifende/sdk';

const sifende = new Sifende({ apiKey: process.env.SIFENDE_API_KEY! });
const pedidoId = '1001'; // el id de la venta en tu sistema

const items = [
  { codigo: 'REM-01', descripcion: 'Remera', cantidad: 2, unidadMedida: 'UNI', precioUnitario: 150_000, afectacionTributaria: 'GRAVADO', tasaIVA: 10 },
  { codigo: 'ENVIO', descripcion: 'Envío', cantidad: 1, unidadMedida: 'UNI', precioUnitario: 25_000, afectacionTributaria: 'GRAVADO', tasaIVA: 10 },
] as const;
const { totalGeneral } = calcularTotales({ items: [...items] });

const documento = await sifende.documentos.emitir(
  {
    tipoDocumento: 'FACTURA_ELECTRONICA',
    tipoEmision: 'NORMAL',
    numeroEstablecimiento: 1,
    puntoExpedicion: 2,
    tipoTransaccion: 'VENTA_MERCADERIA',
    indicadorPresencia: 'OPERACION_ELECTRONICA',
    condicionOperacion: 'CONTADO',
    pagos: [{ tipoPago: 'TRANSFERENCIA', montoPago: totalGeneral, monedaPago: 'PYG' }],
    receptor: {
      tipoContribuyente: 'NO_CONTRIBUYENTE',
      tipoOperacion: 'B2C',
      tipoDocumento: 'INNOMINADO',
      numeroDocumento: '0',
      nombreRazonSocial: 'Sin Nombre',
    },
    items: [...items],
  },
  { idempotencyKey: `pedido-${pedidoId}` },
);

console.log(documento.cdc, documento.estado); // 'PENDIENTE'
```

El documento queda en `PENDIENTE` hasta que SIFEN lo procesa. El resultado llega por [webhook](#webhooks) o con
`documentos.consultarEstado(cdc)`.

En una operación al contado, `montoPago` tiene que coincidir con el total redondeado. `calcularTotales` aplica el
redondeo oficial de la SET: en guaraníes, al múltiplo de 50 inferior.

## Configuración

| Opción | Por defecto | |
|---|---|---|
| `apiKey` | | Obligatoria. |
| `timeoutMs` | `30000` | Tiempo máximo por intento. |
| `maxReintentos` | `2` | Reintentos ante fallas transitorias. `0` los desactiva. |
| `baseUrl` | `https://api.sifende.com.py` | |
| `fetch` | `globalThis.fetch` | Para usar otro cliente HTTP o simular la API en tests. |

## Operaciones

| Método | Endpoint |
|---|---|
| `documentos.emitir(documento, { idempotencyKey })` | `POST /api/v1/documento-electronico` |
| `documentos.consultarEstado(cdc)` | `GET /api/v1/documento-electronico/status/{cdc}` |
| `documentos.descargarKude(cdc)` | `GET /api/v1/documento-electronico/{cdc}/kude` |
| `documentos.descargarKudeTicket(cdc, { ancho, resumen })` | `GET /api/v1/documento-electronico/{cdc}/kude/ticket` |
| `documentos.descargarKudeTicketImagen(cdc, { puntos, resumen })` | `GET /api/v1/documento-electronico/{cdc}/kude/ticket/imagen` |
| `documentos.descargarXml(cdc)` | `GET /api/v1/documento-electronico/{cdc}/xml` |
| `documentos.cancelar(cdc, { motivo })` | `POST /api/v1/documento-electronico/{cdc}/cancelar` |
| `documentos.nominar(cdc, { motivo, receptor })` | `POST /api/v1/documento-electronico/{cdc}/nominar` |
| `documentos.inutilizar(rango)` | `POST /api/v1/documento-electronico/inutilizar` |
| `documentos.listarEventos(filtro)` | `GET /api/v1/documento-electronico/eventos` |
| `documentos.consultarEvento(id)` | `GET /api/v1/documento-electronico/eventos/{id}` |
| `contribuyente.consultar()` | `GET /api/v1/contribuyente` |
| `contribuyente.consultarConsumoPlan()` | `GET /api/v1/contribuyente/plan-consumo` |
| `padron.consultar(rucOCedula)` | `GET /api/v1/padron/{documento}` |
| `catalogos.enumeraciones()` | `GET /api/v1/public/enums` |
| `catalogos.departamentos()`, `distritos(id)`, `ciudades(id)`, `ciudadesDeDepartamento(id)` | `GET /api/v1/geografia/…` |
| `webhooks.listar()`, `crear(webhook)` | `GET`, `POST /api/v1/contribuyente/webhooks` |
| `webhooks.consultar(id)`, `actualizar(id, webhook)`, `eliminar(id)` | `GET`, `PUT`, `DELETE /api/v1/contribuyente/webhooks/{id}` |
| `webhooks.rotarSecreto(id)` | `POST /api/v1/contribuyente/webhooks/{id}/rotar` |
| `webhooks.listarEntregas(id, filtro)` | `GET /api/v1/contribuyente/webhooks/{id}/entregas` |

Los catálogos son públicos y no envían la API key.

`descargarKude` espera hasta 3 minutos a que el PDF esté listo; si no lo está, lanza `KudePendienteError`. Cambiá la
espera con `{ esperarMs }`.

`descargarKudeTicket` devuelve el KuDE en cinta de papel para impresoras térmicas (`ancho` 80 o 58 mm) y
`descargarKudeTicketImagen` el mismo ticket como PNG de 1 bit para ESC/POS (`puntos` 576, 512 o 384). Con
`resumen: true` omiten el detalle de ítems e impuestos. Sólo existen para facturas y notas de crédito o débito.
`descargarXml` devuelve el XML firmado tal como se envió a SIFEN.

Para poder retomar una operación después de un corte, generá vos la `idempotencyKey` y guardala antes de enviar. Si no
la pasás, el SDK genera un UUID que solo reusa en sus propios reintentos.

## Errores

```ts
import { SifendeApiError, SifendeConexionError } from '@sifende/sdk';

try {
  await sifende.documentos.emitir(documento, { idempotencyKey });
} catch (error) {
  if (error instanceof SifendeApiError) {
    error.status; // 400
    error.codigo; // 'validation-error', 'document-quota-exceeded', …
    error.errores; // { 'receptor.digitoVerificador': '…' }
  } else if (error instanceof SifendeConexionError) {
    error.idempotencyKey; // repetí la operación con esta clave
  }
}
```

`SifendeTimeoutError` extiende `SifendeConexionError`: un timeout, incluso a mitad de la respuesta, se trata como un
corte de conexión.

El SDK reintenta solo los casos que la API marca como seguros, y respeta `Retry-After`:

- Cortes de conexión en consultas y en operaciones con clave de idempotencia.
- `409 idempotency-in-progress`, `503 idempotency-upstream-unknown` y `503 evento-nominacion-error`.
- `429`.
- `500`, `502`, `503` y `504` en consultas.

## Webhooks

La firma se calcula sobre el cuerpo tal como llegó. Pasá el texto crudo, antes de cualquier parser JSON:

```ts
import { FirmaWebhookInvalidaError, verificarWebhook } from '@sifende/sdk';

export async function action({ request }: { request: Request }) {
  try {
    const evento = await verificarWebhook({
      cuerpo: await request.text(),
      headers: request.headers,
      secreto: process.env.SIFENDE_WEBHOOK_SECRET!,
    });
    if (evento.tipo === 'documento.aprobado') {
      // evento.data.cdc, evento.data.protocoloAutorizacion
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof FirmaWebhookInvalidaError) return new Response(null, { status: 401 });
    throw error;
  }
}
```

Los tipos de evento son `documento.aprobado`, `documento.rechazado`, `documento.cancelado` y `lote.procesado`.

`webhooks` registra y administra los endpoints. El secreto `whsec_…` llega sólo en la respuesta de `crear` y de
`rotarSecreto`, y ninguno de los dos admite `Idempotency-Key`: el SDK no los repite ante un corte. Si se corta un
`crear`, revisá `listar` antes de volver a intentar.

Una entrega puede repetirse: deduplicá por `evento.id`. `verificarWebhook` rechaza una entrega si su
`X-Sifende-Timestamp` difiere más de 5 minutos de tu reloj; ajustalo con `toleranciaSegundos`. Durante una rotación de secreto, pasá `secreto: [nuevo, anterior]`.

## Desarrollo

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

Los tipos de `src/generado/` se generan desde el OpenAPI de la API. Para regenerarlos contra producción o contra una
copia local del spec:

```bash
npm run generar:tipos
SIFENDE_OPENAPI=./openapi.json npm run generar:tipos
```

## Licencia

[Apache 2.0](LICENSE). Copyright 2026 ITH E.A.S.; ver [NOTICE](NOTICE).
