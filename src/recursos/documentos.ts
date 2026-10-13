import { KudePendienteError, segundosRetryAfter } from '../errores.js';
import type {
  CancelacionRequest,
  DocumentoElectronicoEmisionResponseDto,
  DocumentoElectronicoStatusDto,
  EmitirDocumentoData,
  EventoInutilizacionRequest,
  EventoNominacionRequest,
  EventoSifenDto,
  ListarEventosData,
  PageDtoEventoSifenDto,
} from '../generado/types.gen.js';
import { type ClienteHttp, esperar, type OpcionesIdempotentes, type OpcionesSolicitud } from '../http.js';

const RUTA = '/api/v1/documento-electronico';

export type SolicitudEmision = EmitirDocumentoData['body'];

export interface OpcionesKude extends OpcionesSolicitud {
  /** Cuánto esperar a que el PDF esté listo. Por defecto 3 minutos. */
  esperarMs?: number;
}

export class Documentos {
  constructor(private readonly http: ClienteHttp) {}

  /** Emite un documento. Responde con el CDC en estado `PENDIENTE`; el resultado de SIFEN llega por webhook o consulta. */
  async emitir(
    documento: SolicitudEmision,
    opciones: OpcionesIdempotentes = {},
  ): Promise<DocumentoElectronicoEmisionResponseDto> {
    const respuesta = await this.http.solicitar<DocumentoElectronicoEmisionResponseDto>({
      metodo: 'POST',
      ruta: RUTA,
      cuerpo: documento,
      idempotencyKey: opciones.idempotencyKey ?? crypto.randomUUID(),
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  async consultarEstado(cdc: string, opciones: OpcionesSolicitud = {}): Promise<DocumentoElectronicoStatusDto> {
    const respuesta = await this.http.solicitar<DocumentoElectronicoStatusDto>({
      metodo: 'GET',
      ruta: `${RUTA}/status/${encodeURIComponent(cdc)}`,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  /** Descarga el PDF del KuDE y espera mientras Sifende lo prepara. */
  async descargarKude(cdc: string, opciones: OpcionesKude = {}): Promise<Uint8Array> {
    const ruta = `${RUTA}/${encodeURIComponent(cdc)}/kude`;
    const inicio = Date.now();
    const limite = inicio + (opciones.esperarMs ?? 180_000);
    let reintentoSinConsultaHecho = false;
    let soloConsulta = false;

    for (;;) {
      const respuesta = await this.http.solicitar<Uint8Array>({
        metodo: 'GET',
        ruta,
        query: soloConsulta ? { soloConsulta: true } : undefined,
        binario: true,
        signal: opciones.signal,
      });
      if (respuesta.status !== 202) return respuesta.datos;

      const espera = (segundosRetryAfter(respuesta.headers.get('retry-after')) ?? 5) * 1000;
      if (Date.now() + espera > limite) throw new KudePendienteError(cdc);
      await esperar(espera, opciones.signal);

      // Con soloConsulta no se vuelve a pedir la preparación: a los 2 minutos se repite una vez sin él.
      soloConsulta = reintentoSinConsultaHecho || Date.now() - inicio < 120_000;
      if (!soloConsulta) reintentoSinConsultaHecho = true;
    }
  }

  async cancelar(
    cdc: string,
    solicitud: CancelacionRequest,
    opciones: OpcionesIdempotentes = {},
  ): Promise<EventoSifenDto> {
    return this.evento(`${RUTA}/${encodeURIComponent(cdc)}/cancelar`, solicitud, opciones);
  }

  /** Identifica al receptor de una factura emitida como innominada. */
  async nominar(
    cdc: string,
    solicitud: EventoNominacionRequest,
    opciones: OpcionesIdempotentes = {},
  ): Promise<EventoSifenDto> {
    return this.evento(`${RUTA}/${encodeURIComponent(cdc)}/nominar`, solicitud, opciones);
  }

  async inutilizar(
    solicitud: EventoInutilizacionRequest,
    opciones: OpcionesIdempotentes = {},
  ): Promise<EventoSifenDto> {
    return this.evento(`${RUTA}/inutilizar`, solicitud, opciones);
  }

  async listarEventos(
    filtro: NonNullable<ListarEventosData['query']> = {},
    opciones: OpcionesSolicitud = {},
  ): Promise<PageDtoEventoSifenDto> {
    const respuesta = await this.http.solicitar<PageDtoEventoSifenDto>({
      metodo: 'GET',
      ruta: `${RUTA}/eventos`,
      query: filtro,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  async consultarEvento(eventoId: number, opciones: OpcionesSolicitud = {}): Promise<EventoSifenDto> {
    const respuesta = await this.http.solicitar<EventoSifenDto>({
      metodo: 'GET',
      ruta: `${RUTA}/eventos/${encodeURIComponent(eventoId)}`,
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  private async evento(ruta: string, cuerpo: unknown, opciones: OpcionesIdempotentes): Promise<EventoSifenDto> {
    const respuesta = await this.http.solicitar<EventoSifenDto>({
      metodo: 'POST',
      ruta,
      cuerpo,
      idempotencyKey: opciones.idempotencyKey ?? crypto.randomUUID(),
      signal: opciones.signal,
    });
    return respuesta.datos;
  }
}
