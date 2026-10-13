# @sifende/sdk

SDK de Sifende para TypeScript y JavaScript: emití facturas electrónicas, notas de crédito y eventos de SIFEN, verificá
webhooks y calculá totales con las mismas reglas que la API.

- Sin dependencias en runtime: usa `fetch` y Web Crypto nativos (Node 22.18+, Deno, Bun, Cloudflare Workers).
- Tipos generados desde el OpenAPI de la API.
- Reintentos seguros: cada operación tributaria viaja con `Idempotency-Key`.

> Usalo sólo del lado del servidor. La API key no puede viajar al navegador ni dentro de una app distribuida.

## Uso

```ts
import { Sifende, calcularTotales } from '@sifende/sdk';

const sifende = new Sifende({ apiKey: process.env.SIFENDE_API_KEY! });

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
  { idempotencyKey: `pedido-${pedido.id}` },
);

console.log(documento.cdc, documento.estado); // PENDIENTE hasta que SIFEN responda
```

`calcularTotales` reproduce el redondeo oficial de la SET (múltiplo de 50 hacia abajo en guaraníes): en una operación
al contado, `montoPago` tiene que coincidir con ese total.

## Operaciones

| Método | Endpoint |
|---|---|
| `documentos.emitir(documento, { idempotencyKey })` | `POST /api/v1/documento-electronico` |
| `documentos.consultarEstado(cdc)` | `GET /api/v1/documento-electronico/status/{cdc}` |
| `documentos.descargarKude(cdc)` | `GET /api/v1/documento-electronico/{cdc}/kude`; espera mientras el PDF se prepara |
| `documentos.cancelar(cdc, { motivo })` | `POST /api/v1/documento-electronico/{cdc}/cancelar` |
| `documentos.nominar(cdc, { motivo, receptor })` | `POST /api/v1/documento-electronico/{cdc}/nominar` |
| `documentos.inutilizar(rango)` | `POST /api/v1/documento-electronico/inutilizar` |
| `documentos.listarEventos(filtro)` / `consultarEvento(id)` | `GET /api/v1/documento-electronico/eventos` |
| `contribuyente.consultar()` / `consultarConsumoPlan()` | `GET /api/v1/contribuyente`, `/plan-consumo` |
| `padron.consultar(rucOCedula)` | `GET /api/v1/padron/{documento}` |
| `catalogos.enumeraciones()`, `departamentos()`, `distritos(id)`, `ciudades(id)` | Catálogos públicos |

Si no pasás `idempotencyKey`, el SDK genera un UUID y lo reusa en sus reintentos. Para poder recuperar una operación
después de un corte, generá vos la clave y guardala antes de enviar.

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

El SDK reintenta solo los casos que la API marca como seguros: cortes de conexión con clave de idempotencia,
`409 idempotency-in-progress`, `503 idempotency-upstream-unknown`, `503 evento-nominacion-error`, `429`, y 500, 502,
503 o 504 en consultas. Respeta `Retry-After`. Un corte o un timeout mientras llega la respuesta cuenta como corte de
conexión.

## Webhooks

Pasá el cuerpo crudo, antes de cualquier parser JSON:

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

Durante una rotación de secreto podés pasar `secreto: [nuevo, anterior]`. Una entrega puede repetirse: deduplicá por
`evento.id`.

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
