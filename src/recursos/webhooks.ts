import type {
  ActualizarWebhookIntegracionRequest,
  CrearWebhookIntegracionRequest,
  ListarEntregasWebhookData,
  WebhookEndpointDto,
  WebhookEntregaPaginaDto,
  WebhookSecretResponse,
} from '../generado/types.gen.js';
import type { ClienteHttp, OpcionesSolicitud } from '../http.js';

const RUTA = '/api/v1/contribuyente/webhooks';

export type FiltroEntregas = NonNullable<ListarEntregasWebhookData['query']>;

/**
 * Administra los webhooks del contribuyente en el ambiente de la API key. Para verificar las entregas que llegan a tu
 * endpoint, usá `verificarWebhook`.
 *
 * `crear` y `rotarSecreto` no admiten `Idempotency-Key`, así que el SDK no los repite ante un corte de conexión: el
 * secreto sólo viaja en esa respuesta.
 */
export class Webhooks {
  constructor(private readonly http: ClienteHttp) {}

  /** Los webhooks del ambiente de la API key, los más recientes primero, sin el secreto. */
  async listar(opciones: OpcionesSolicitud = {}): Promise<WebhookEndpointDto[]> {
    const respuesta = await this.http.solicitar<WebhookEndpointDto[]>({
      metodo: 'GET',
      ruta: RUTA,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  /**
   * Registra una URL HTTPS pública para recibir eventos. Hay hasta cinco webhooks activos por ambiente.
   *
   * El secreto `whsec_…` llega sólo en esta respuesta: guardalo. Si se corta la conexión, consultá `listar` antes de
   * repetir: una URL ya registrada responde 400 `validation-error`.
   */
  async crear(
    webhook: CrearWebhookIntegracionRequest,
    opciones: OpcionesSolicitud = {},
  ): Promise<WebhookSecretResponse> {
    const respuesta = await this.http.solicitar<WebhookSecretResponse>({
      metodo: 'POST',
      ruta: RUTA,
      cuerpo: webhook,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  /** Un webhook, sin el secreto. Uno de otro ambiente responde 404. */
  async consultar(webhookId: number, opciones: OpcionesSolicitud = {}): Promise<WebhookEndpointDto> {
    const respuesta = await this.http.solicitar<WebhookEndpointDto>({
      metodo: 'GET',
      ruta: ruta(webhookId),
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  /**
   * Reemplaza la URL, los eventos y el estado. `activo: false` pausa el webhook y cancela sus entregas pendientes. El
   * secreto no cambia: para eso, `rotarSecreto`.
   */
  async actualizar(
    webhookId: number,
    webhook: ActualizarWebhookIntegracionRequest,
    opciones: OpcionesSolicitud = {},
  ): Promise<WebhookEndpointDto> {
    const respuesta = await this.http.solicitar<WebhookEndpointDto>({
      metodo: 'PUT',
      ruta: ruta(webhookId),
      cuerpo: webhook,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  /** Borra el webhook y cancela sus entregas pendientes. No se puede deshacer. */
  async eliminar(webhookId: number, opciones: OpcionesSolicitud = {}): Promise<void> {
    await this.http.solicitar({ metodo: 'DELETE', ruta: ruta(webhookId), signal: opciones.signal });
  }

  /**
   * Genera un secreto nuevo y deja de firmar con el anterior, también las entregas pendientes. El secreto llega sólo
   * en esta respuesta; si no la recibiste, volvé a rotar.
   *
   * Para no perder entregas durante el cambio, verificá con los dos secretos hasta actualizar tu endpoint:
   * `verificarWebhook({ secreto: [nuevo, anterior], … })`.
   */
  async rotarSecreto(webhookId: number, opciones: OpcionesSolicitud = {}): Promise<WebhookSecretResponse> {
    const respuesta = await this.http.solicitar<WebhookSecretResponse>({
      metodo: 'POST',
      ruta: `${ruta(webhookId)}/rotar`,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  /** Historial de entregas del webhook, las más recientes primero: estado, intentos y último error. Se conserva 90 días. */
  async listarEntregas(
    webhookId: number,
    filtro: FiltroEntregas = {},
    opciones: OpcionesSolicitud = {},
  ): Promise<WebhookEntregaPaginaDto> {
    const respuesta = await this.http.solicitar<WebhookEntregaPaginaDto>({
      metodo: 'GET',
      ruta: `${ruta(webhookId)}/entregas`,
      query: filtro,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }
}

function ruta(webhookId: number): string {
  return `${RUTA}/${encodeURIComponent(webhookId)}`;
}
