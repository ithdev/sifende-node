import { type Ambiente, ClienteHttp, type OpcionesCliente } from './http.js';
import { Catalogos } from './recursos/catalogos.js';
import { Contribuyente } from './recursos/contribuyente.js';
import { Documentos } from './recursos/documentos.js';
import { Padron } from './recursos/padron.js';

export class Sifende {
  readonly documentos: Documentos;
  readonly contribuyente: Contribuyente;
  readonly padron: Padron;
  readonly catalogos: Catalogos;
  /** Ambiente que fija la API key (`sk_live_` → PROD, `sk_test_` → DEV, `sk_sandbox_` → SANDBOX). */
  readonly ambiente: Ambiente | undefined;

  constructor(opciones: OpcionesCliente) {
    const http = new ClienteHttp(opciones);
    this.ambiente = http.ambiente;
    this.documentos = new Documentos(http);
    this.contribuyente = new Contribuyente(http);
    this.padron = new Padron(http);
    this.catalogos = new Catalogos(http);
  }
}
