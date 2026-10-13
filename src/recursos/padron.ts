import type { ApiResponsePadron, Padron as DatosPadron } from '../generado/types.gen.js';
import type { ClienteHttp, OpcionesSolicitud } from '../http.js';

export class Padron {
  constructor(private readonly http: ClienteHttp) {}

  /** Busca un RUC o una cédula, con o sin puntos y dígito verificador. Los campos encajan con el receptor. */
  async consultar(documento: string, opciones: OpcionesSolicitud = {}): Promise<DatosPadron | undefined> {
    const respuesta = await this.http.solicitar<ApiResponsePadron>({
      metodo: 'GET',
      ruta: `/api/v1/padron/${encodeURIComponent(documento)}`,
      signal: opciones.signal,
    });
    return respuesta.datos.data;
  }
}
