import { Decimal } from './decimal.js';

type Monto = number | string;

export interface ItemParaTotales {
  precioUnitario: Monto;
  cantidad: Monto;
  afectacionTributaria: string;
  tasaIVA?: number | null | undefined;
  propIVA?: Monto | null | undefined;
  tipoCambio?: Monto | null | undefined;
  descuentoParticular?: Monto | null | undefined;
  descuentoParticularPorcentaje?: Monto | null | undefined;
  anticipoParticular?: Monto | null | undefined;
}

export interface DocumentoParaTotales {
  monedaOperacion?: string | null | undefined;
  tipoCambio?: Monto | null | undefined;
  descuentoGlobalPorcentaje?: Monto | null | undefined;
  anticipoGlobalPorcentaje?: Monto | null | undefined;
  comision?: Monto | null | undefined;
  items: readonly ItemParaTotales[];
}

export interface Totales {
  /** Suma de los ítems antes del redondeo (F014-F017). */
  totalOperacion: number;
  /** Redondeo oficial de la SET (F013): en PYG, lo que se descuenta para llegar a un múltiplo de 50. */
  redondeo: number;
  /** Total a cobrar (F014): el `montoPago` de una operación al contado en la moneda de la operación. */
  totalGeneral: number;
  /** Total en guaraníes (F023); 0 en PYG. */
  totalGuaranies: number;
}

const CIEN = Decimal.de(100);
const CINCUENTA = Decimal.de(50);
const DIEZ_MIL = Decimal.de(10000);
// Igual que FiscalTotalCalculator.GLOBAL_DISCOUNT_FOREIGN_SCALE.
const ESCALA_DESCUENTO_EXTRANJERA = 8;

/**
 * Calcula los totales con las mismas reglas que Sifende valida al emitir, para que `montoPago` coincida con el total
 * redondeado sin un ida y vuelta a la API.
 */
export function calcularTotales(documento: DocumentoParaTotales): Totales {
  const moneda = documento.monedaOperacion ?? 'PYG';
  const esGuarani = moneda === 'PYG';
  const escala = esGuarani ? 0 : 2;
  const cambioGlobal = opcional(documento.tipoCambio);

  let totalOperacion = Decimal.CERO;
  let totalGuaraniesItems = Decimal.CERO;

  for (const item of documento.items) {
    const precio = Decimal.de(item.precioUnitario);
    const descuentoParticular =
      item.descuentoParticularPorcentaje == null
        ? opcional(item.descuentoParticular)
        : porcentajeSobrePrecio(esGuarani, precio, Decimal.de(item.descuentoParticularPorcentaje));
    const descuentoGlobal =
      documento.descuentoGlobalPorcentaje == null
        ? undefined
        : porcentajeSobrePrecio(esGuarani, precio, Decimal.de(documento.descuentoGlobalPorcentaje));
    const anticipoGlobal =
      documento.anticipoGlobalPorcentaje == null
        ? undefined
        : porcentajeSobrePrecio(esGuarani, precio, Decimal.de(documento.anticipoGlobalPorcentaje));

    const precioNeto = [
      descuentoParticular,
      descuentoGlobal,
      opcional(item.anticipoParticular),
      anticipoGlobal,
    ].reduce<Decimal>((acumulado, deduccion) => (deduccion ? acumulado.restar(deduccion) : acumulado), precio);
    const totalItem = precioNeto.multiplicar(Decimal.de(item.cantidad)).conEscala(escala);

    if (!esGuarani && cambioGlobal === undefined) {
      if (item.tipoCambio == null) {
        throw new TypeError(`El ítem necesita tipoCambio cuando la operación en ${moneda} no tiene tipoCambio global`);
      }
      totalGuaraniesItems = totalGuaraniesItems.sumar(totalItem.multiplicar(Decimal.de(item.tipoCambio)));
    }

    totalOperacion = totalOperacion.sumar(aporteAlTotal(item, totalItem, escala));
  }

  const redondeo = esGuarani ? totalOperacion.resto(CINCUENTA) : Decimal.CERO;
  const comision = opcional(documento.comision)?.conEscala(escala) ?? Decimal.CERO;
  const totalGeneral = totalOperacion.restar(redondeo).sumar(comision);
  const totalGuaranies = esGuarani
    ? Decimal.CERO
    : cambioGlobal === undefined
      ? totalGuaraniesItems
      : totalGeneral.multiplicar(cambioGlobal);

  return {
    totalOperacion: totalOperacion.aNumero(),
    redondeo: redondeo.abs().aNumero(),
    totalGeneral: totalGeneral.aNumero(),
    totalGuaranies: totalGuaranies.aNumero(),
  };
}

function aporteAlTotal(item: ItemParaTotales, totalItem: Decimal, escala: number): Decimal {
  switch (item.afectacionTributaria) {
    case 'EXENTO':
    case 'EXONERADO':
      return totalItem;
    case 'GRAVADO':
      return tasaValida(item.tasaIVA) ? totalItem : Decimal.CERO;
    case 'GRAVADO_PARCIAL': {
      if (!tasaValida(item.tasaIVA)) return Decimal.CERO;
      if (item.propIVA == null) return totalItem;
      // NT013: el gravado parcial aporta base gravada + liquidación + base exenta, cada una redondeada.
      const tasa = Decimal.de(item.tasaIVA);
      const proporcion = Decimal.de(item.propIVA);
      const denominador = DIEZ_MIL.sumar(tasa.multiplicar(proporcion));
      const base = CIEN.multiplicar(totalItem).multiplicar(proporcion).dividir(denominador, escala);
      const liquidacion = base.multiplicar(tasa).dividir(CIEN, escala);
      const exenta = CIEN.multiplicar(totalItem).multiplicar(CIEN.restar(proporcion)).dividir(denominador, escala);
      return base.sumar(liquidacion).sumar(exenta);
    }
    default:
      return Decimal.CERO;
  }
}

function porcentajeSobrePrecio(esGuarani: boolean, precio: Decimal, porcentaje: Decimal): Decimal {
  const exacto = precio.multiplicar(porcentaje).dividir(CIEN, precio.escala + porcentaje.escala + 2);
  return exacto.conEscala(esGuarani ? 0 : ESCALA_DESCUENTO_EXTRANJERA);
}

function tasaValida(tasa: number | null | undefined): tasa is 5 | 10 {
  return tasa === 5 || tasa === 10;
}

function opcional(valor: Monto | null | undefined): Decimal | undefined {
  return valor == null ? undefined : Decimal.de(valor);
}
