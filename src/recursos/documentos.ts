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
import {
  ACEPTA_PDF,
  ACEPTA_PNG,
  ACEPTA_XML,
  type ClienteHttp,
  esperar,
  type OpcionesIdempotentes,
  type OpcionesSolicitud,
} from '../http.js';

const RUTA = '/api/v1/documento-electronico';

export type SolicitudEmision = EmitirDocumentoData['body'];

export interface OpcionesKude extends OpcionesSolicitud {
  /** Cuánto esperar a que el PDF esté listo. Por defecto 3 minutos. */
  esperarMs?: number;
}

export interface OpcionesTicket extends OpcionesSolicitud {
  /** Ancho del papel en mm: 80 o 58. Por defecto 80. */
  ancho?: 80 | 58;
  /** Omite el detalle de ítems y de impuestos (Manual Técnico V150, cap. 13.7). */
  resumen?: boolean;
}

export interface OpcionesTicketImagen extends OpcionesSolicitud {
  /** Puntos por línea de la impresora a 203 dpi: 576 o 512 para papel de 80 mm, 384 para 58 mm. Por defecto 576. */
  puntos?: 576 | 512 | 384;
  /** Omite el detalle de ítems y de impuestos (Manual Técnico V150, cap. 13.7). */
  resumen?: boolean;
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

  /** Descarga el PDF del KuDE y espera mientras Sifende lo prepara, como mucho `esperarMs` en total. */
  async descargarKude(cdc: string, opciones: OpcionesKude = {}): Promise<Uint8Array> {
    const esperarMs = opciones.esperarMs ?? 180_000;
    // El plazo cubre todo: cada GET, sus reintentos y las esperas entre consultas.
    const plazo = AbortSignal.timeout(esperarMs);
    const signal = opciones.signal ? AbortSignal.any([opciones.signal, plazo]) : plazo;
    try {
      return await this.esperarKude(cdc, Date.now() + esperarMs, signal);
    } catch (error) {
      if (plazo.aborted && !opciones.signal?.aborted) throw new KudePendienteError(cdc);
      throw error;
    }
  }

  private async esperarKude(cdc: string, limite: number, signal: AbortSignal): Promise<Uint8Array> {
    const ruta = `${RUTA}/${encodeURIComponent(cdc)}/kude`;
    const inicio = Date.now();
    let reintentoSinConsultaHecho = false;
    let soloConsulta = false;

    for (;;) {
      const respuesta = await this.http.solicitar<Uint8Array>({
        metodo: 'GET',
        ruta,
        query: soloConsulta ? { soloConsulta: true } : undefined,
        acepta: ACEPTA_PDF,
        binario: true,
        signal,
      });
      if (respuesta.status !== 202) return respuesta.datos;

      const espera = (segundosRetryAfter(respuesta.headers.get('retry-after')) ?? 5) * 1000;
      if (Date.now() + espera > limite) throw new KudePendienteError(cdc);
      await esperar(espera, signal);

      // Con soloConsulta no se vuelve a pedir la preparación: a los 2 minutos se repite una vez sin él.
      soloConsulta = reintentoSinConsultaHecho || Date.now() - inicio < 120_000;
      if (!soloConsulta) reintentoSinConsultaHecho = true;
    }
  }

  /**
   * Descarga el XML firmado tal como se envió a SIFEN, con el código QR incluido. Está disponible desde que el
   * documento se registra; si todavía no tiene XML, la API responde 409 `documento-xml-not-available`.
   */
  async descargarXml(cdc: string, opciones: OpcionesSolicitud = {}): Promise<string> {
    const respuesta = await this.http.solicitar<string | undefined>({
      metodo: 'GET',
      ruta: `${RUTA}/${encodeURIComponent(cdc)}/xml`,
      acepta: ACEPTA_XML,
      signal: opciones.signal,
    });
    return respuesta.datos ?? '';
  }

  /**
   * Descarga el KuDE en cinta de papel (PDF) para impresoras térmicas de 80 o 58 mm. Sólo existe para facturas y
   * notas de crédito o débito: otros tipos responden 501 `kude-not-supported`.
   */
  async descargarKudeTicket(cdc: string, opciones: OpcionesTicket = {}): Promise<Uint8Array> {
    return this.descargarTicket(`${RUTA}/${encodeURIComponent(cdc)}/kude/ticket`, ACEPTA_PDF, opciones, {
      ancho: opciones.ancho,
    });
  }

  /**
   * Descarga el ticket como PNG de 1 bit con el ancho exacto de una línea de la impresora, para imprimirlo con el
   * comando de imagen ráster de ESC/POS (GS v 0).
   */
  async descargarKudeTicketImagen(cdc: string, opciones: OpcionesTicketImagen = {}): Promise<Uint8Array> {
    return this.descargarTicket(`${RUTA}/${encodeURIComponent(cdc)}/kude/ticket/imagen`, ACEPTA_PNG, opciones, {
      puntos: opciones.puntos,
    });
  }

  private async descargarTicket(
    ruta: string,
    acepta: string,
    opciones: OpcionesSolicitud & { resumen?: boolean },
    medida: Record<string, number | undefined>,
  ): Promise<Uint8Array> {
    const respuesta = await this.http.solicitar<Uint8Array>({
      metodo: 'GET',
      ruta,
      query: { ...medida, resumen: opciones.resumen || undefined },
      acepta,
      binario: true,
      signal: opciones.signal,
    });
    return respuesta.datos;
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
