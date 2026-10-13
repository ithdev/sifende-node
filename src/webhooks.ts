import { FirmaWebhookInvalidaError } from './errores.js';
import type { Ambiente } from './http.js';

export interface ResultadoSifen {
  codigo: string;
  mensaje: string;
}

export interface DatosDocumento {
  documentoId: string;
  cdc: string;
  estado: string;
  loteId: number | null;
  protocoloAutorizacion: string | null;
  resultados: ResultadoSifen[];
}

export interface DatosCancelacion {
  documentoId: string;
  cdc: string;
  estado: string;
  eventoSifenId: number;
  motivo: string;
  codigoRespuesta: string | null;
  mensajeRespuesta: string | null;
  protocoloAutorizacion: string | null;
}

export interface DatosLote {
  loteId: number;
  numeroLote: string;
  estado: string;
  aprobados: number;
  aprobadosConObservacion: number;
  rechazados: number;
  documentos: Omit<DatosDocumento, 'loteId'>[];
}

interface Sobre<T extends string, D> {
  id: string;
  tipo: T;
  version: string;
  ocurridoEn: string;
  contribuyenteId: number;
  /** Puede faltar en entregas creadas antes de que se agregara el campo. */
  ambiente?: Ambiente;
  data: D;
}

export type EventoWebhook =
  | Sobre<'documento.aprobado' | 'documento.rechazado', DatosDocumento>
  | Sobre<'documento.cancelado', DatosCancelacion>
  | Sobre<'lote.procesado', DatosLote>;

export type TipoEventoWebhook = EventoWebhook['tipo'];

export type HeadersWebhook = Headers | Record<string, string | string[] | undefined>;

export interface OpcionesVerificacion {
  /** Cuerpo crudo tal como llegó: la firma se calcula sobre bytes, no sobre el JSON reserializado. */
  cuerpo: string | Uint8Array | ArrayBuffer;
  headers: HeadersWebhook;
  /** Secreto `whsec_…` del endpoint. Durante una rotación se pueden pasar el nuevo y el anterior. */
  secreto: string | readonly string[];
  /** Antigüedad máxima aceptada de `X-Sifende-Timestamp`. Por defecto 300 s. */
  toleranciaSegundos?: number;
  ahora?: Date;
}

const codificador = new TextEncoder();

/**
 * Verifica la firma `X-Sifende-Signature` y devuelve el evento. Lanza {@link FirmaWebhookInvalidaError} si la firma
 * no coincide, faltan headers o el timestamp está fuera de la tolerancia. Deduplicá por `evento.id`: una entrega puede
 * repetirse.
 */
export async function verificarWebhook(opciones: OpcionesVerificacion): Promise<EventoWebhook> {
  const eventId = leerHeader(opciones.headers, 'x-sifende-event-id');
  const deliveryId = leerHeader(opciones.headers, 'x-sifende-delivery-id');
  const timestamp = leerHeader(opciones.headers, 'x-sifende-timestamp');
  const firma = leerHeader(opciones.headers, 'x-sifende-signature');
  if (!eventId || !deliveryId || !timestamp || !firma) {
    throw new FirmaWebhookInvalidaError('Faltan headers X-Sifende-* en el webhook');
  }

  const segundos = Number(timestamp);
  const tolerancia = opciones.toleranciaSegundos ?? 300;
  const ahora = (opciones.ahora ?? new Date()).getTime() / 1000;
  if (!Number.isInteger(segundos) || Math.abs(ahora - segundos) > tolerancia) {
    throw new FirmaWebhookInvalidaError('X-Sifende-Timestamp está fuera de la tolerancia');
  }

  const cuerpo = aBytes(opciones.cuerpo);
  const recibidas = firma
    .split(/[\s,]+/)
    .filter((parte) => parte.startsWith('v1='))
    .map((parte) => base64ABytes(parte.slice(3)))
    .filter((bytes): bytes is Uint8Array => bytes !== undefined);
  const secretos = typeof opciones.secreto === 'string' ? [opciones.secreto] : opciones.secreto;

  for (const secreto of secretos) {
    const esperada = await firmar(secreto, `${eventId}.${deliveryId}.${timestamp}.`, cuerpo);
    if (recibidas.some((recibida) => igualesEnTiempoConstante(recibida, esperada))) {
      return JSON.parse(new TextDecoder().decode(cuerpo)) as EventoWebhook;
    }
  }
  throw new FirmaWebhookInvalidaError('La firma del webhook no coincide');
}

/** Calcula `X-Sifende-Signature` para un cuerpo dado. Útil para probar tu endpoint. */
export async function firmarWebhook(opciones: {
  secreto: string;
  eventId: string;
  deliveryId: string;
  timestamp: number;
  cuerpo: string | Uint8Array | ArrayBuffer;
}): Promise<string> {
  const { secreto, eventId, deliveryId, timestamp, cuerpo } = opciones;
  const firma = await firmar(secreto, `${eventId}.${deliveryId}.${timestamp}.`, aBytes(cuerpo));
  return `v1=${bytesABase64(firma)}`;
}

async function firmar(secreto: string, prefijo: string, cuerpo: Uint8Array): Promise<Uint8Array> {
  const clave = await crypto.subtle.importKey(
    'raw',
    codificador.encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const inicio = codificador.encode(prefijo);
  const mensaje = new Uint8Array(inicio.length + cuerpo.length);
  mensaje.set(inicio);
  mensaje.set(cuerpo, inicio.length);
  return new Uint8Array(await crypto.subtle.sign('HMAC', clave, mensaje));
}

function leerHeader(headers: HeadersWebhook, nombre: string): string | undefined {
  if (headers instanceof Headers) return headers.get(nombre) ?? undefined;
  const entrada = Object.entries(headers).find(([clave]) => clave.toLowerCase() === nombre)?.[1];
  return Array.isArray(entrada) ? entrada[0] : entrada;
}

function aBytes(cuerpo: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof cuerpo === 'string') return codificador.encode(cuerpo);
  return cuerpo instanceof Uint8Array ? cuerpo : new Uint8Array(cuerpo);
}

function igualesEnTiempoConstante(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diferencia === 0;
}

function bytesABase64(bytes: Uint8Array): string {
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario);
}

function base64ABytes(texto: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(texto), (caracter) => caracter.charCodeAt(0));
  } catch {
    return undefined;
  }
}
