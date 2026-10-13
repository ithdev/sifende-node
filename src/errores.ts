/** Problem Details (RFC 9457) tal como lo devuelve Sifende, con sus extensiones. */
export interface ProblemDetail {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  traceId?: string;
  errores?: Record<string, string>;
  [extension: string]: unknown;
}

export class SifendeError extends Error {
  override name = 'SifendeError';
}

export interface DatosErrorApi {
  status: number;
  cuerpo: unknown;
  headers: Headers;
  idempotencyKey?: string | undefined;
}

export class SifendeApiError extends SifendeError {
  override name = 'SifendeApiError';
  readonly status: number;
  /** Último segmento del `type`, por ejemplo `validation-error` o `document-quota-exceeded`. */
  readonly codigo: string | undefined;
  readonly problema: ProblemDetail | undefined;
  readonly cuerpo: unknown;
  readonly traceId: string | undefined;
  /** Segundos de `Retry-After`, si vino. */
  readonly reintentarEn: number | undefined;
  /** Clave con la que se envió la operación: repetila para recuperar el resultado. */
  readonly idempotencyKey: string | undefined;

  constructor({ status, cuerpo, headers, idempotencyKey }: DatosErrorApi) {
    const problema = esProblema(cuerpo) ? cuerpo : undefined;
    super(mensaje(status, cuerpo, problema));
    this.status = status;
    this.cuerpo = cuerpo;
    this.problema = problema;
    this.codigo = problema?.type?.split('/').filter(Boolean).at(-1);
    this.traceId = problema?.traceId ?? headers.get('x-trace-id') ?? undefined;
    this.reintentarEn = segundosRetryAfter(headers.get('retry-after'));
    this.idempotencyKey = idempotencyKey;
  }

  /** Errores de validación por campo (`errores` en un `validation-error`). */
  get errores(): Record<string, string> {
    return this.problema?.errores ?? {};
  }
}

export class SifendeConexionError extends SifendeError {
  override name = 'SifendeConexionError';
  readonly idempotencyKey: string | undefined;

  constructor(mensaje: string, opciones: { cause?: unknown; idempotencyKey?: string | undefined } = {}) {
    super(mensaje, { cause: opciones.cause });
    this.idempotencyKey = opciones.idempotencyKey;
  }
}

export class SifendeTimeoutError extends SifendeConexionError {
  override name = 'SifendeTimeoutError';
}

export class FirmaWebhookInvalidaError extends SifendeError {
  override name = 'FirmaWebhookInvalidaError';
}

export function segundosRetryAfter(valor: string | null): number | undefined {
  if (valor == null || valor.trim() === '') return undefined;
  const segundos = Number(valor);
  if (Number.isFinite(segundos)) return Math.max(0, segundos);
  const fecha = Date.parse(valor);
  return Number.isNaN(fecha) ? undefined : Math.max(0, (fecha - Date.now()) / 1000);
}

function esProblema(cuerpo: unknown): cuerpo is ProblemDetail {
  return typeof cuerpo === 'object' && cuerpo !== null && ('type' in cuerpo || 'title' in cuerpo || 'detail' in cuerpo);
}

function mensaje(status: number, cuerpo: unknown, problema: ProblemDetail | undefined): string {
  if (problema) return `${status} ${problema.title ?? ''}${problema.detail ? `: ${problema.detail}` : ''}`.trim();
  if (typeof cuerpo === 'object' && cuerpo !== null && 'error' in cuerpo) return `${status} ${String(cuerpo.error)}`;
  return `La API de Sifende respondió ${status}`;
}

export class KudePendienteError extends SifendeError {
  override name = 'KudePendienteError';
  readonly cdc: string;

  constructor(cdc: string) {
    super(`El KuDE de ${cdc} sigue en preparación`);
    this.cdc = cdc;
  }
}
