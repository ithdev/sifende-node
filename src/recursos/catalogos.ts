import type {
  ApiResponseListCiudadDto,
  ApiResponseListDepartamentoDto,
  ApiResponseListDistritoDto,
  CiudadDto,
  DepartamentoDto,
  DistritoDto,
  ListarEnumeracionesResponse,
} from '../generado/types.gen.js';
import type { ClienteHttp, OpcionesSolicitud } from '../http.js';

export class Catalogos {
  constructor(private readonly http: ClienteHttp) {}

  /** Valores aceptados por cada enumeración de la API (`unidadMedida`, `tipoPago`, …). No requiere API key. */
  async enumeraciones(opciones: OpcionesSolicitud = {}): Promise<ListarEnumeracionesResponse> {
    return this.obtener<ListarEnumeracionesResponse>('/api/v1/public/enums', opciones);
  }

  async departamentos(opciones: OpcionesSolicitud = {}): Promise<DepartamentoDto[]> {
    const datos = await this.obtener<ApiResponseListDepartamentoDto>('/api/v1/geografia/departamentos', opciones);
    return datos.data ?? [];
  }

  async distritos(departamentoId: number, opciones: OpcionesSolicitud = {}): Promise<DistritoDto[]> {
    const datos = await this.obtener<ApiResponseListDistritoDto>(
      `/api/v1/geografia/departamentos/${encodeURIComponent(departamentoId)}/distritos`,
      opciones,
    );
    return datos.data ?? [];
  }

  async ciudades(distritoId: number, opciones: OpcionesSolicitud = {}): Promise<CiudadDto[]> {
    const datos = await this.obtener<ApiResponseListCiudadDto>(
      `/api/v1/geografia/distritos/${encodeURIComponent(distritoId)}/ciudades`,
      opciones,
    );
    return datos.data ?? [];
  }

  /** Todas las ciudades de un departamento, sin pasar por sus distritos, con el código que SIFEN espera. */
  async ciudadesDeDepartamento(departamentoId: number, opciones: OpcionesSolicitud = {}): Promise<CiudadDto[]> {
    const datos = await this.obtener<ApiResponseListCiudadDto>(
      `/api/v1/geografia/departamentos/${encodeURIComponent(departamentoId)}/ciudades`,
      opciones,
    );
    return datos.data ?? [];
  }

  private async obtener<T>(ruta: string, opciones: OpcionesSolicitud): Promise<T> {
    const respuesta = await this.http.solicitar<T>({ metodo: 'GET', ruta, autenticar: false, signal: opciones.signal });
    return respuesta.datos;
  }
}
