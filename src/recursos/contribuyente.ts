import type { ContribuyenteIntegracionDto, PlanConsumoDto } from '../generado/types.gen.js';
import type { ClienteHttp, OpcionesSolicitud } from '../http.js';

export class Contribuyente {
  constructor(private readonly http: ClienteHttp) {}

  /** Datos del contribuyente de la API key: RUC, establecimientos, puntos de expedición y si está listo para emitir. */
  async consultar(opciones: OpcionesSolicitud = {}): Promise<ContribuyenteIntegracionDto> {
    const respuesta = await this.http.solicitar<ContribuyenteIntegracionDto>({
      metodo: 'GET',
      ruta: '/api/v1/contribuyente',
      signal: opciones.signal,
    });
    return respuesta.datos;
  }

  async consultarConsumoPlan(opciones: OpcionesSolicitud = {}): Promise<PlanConsumoDto> {
    const respuesta = await this.http.solicitar<PlanConsumoDto>({
      metodo: 'GET',
      ruta: '/api/v1/contribuyente/plan-consumo',
      signal: opciones.signal,
    });
    return respuesta.datos;
  }
}
