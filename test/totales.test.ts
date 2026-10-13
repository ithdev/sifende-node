import { describe, expect, it } from 'vitest';
import { calcularTotales } from '../src/totales.js';

describe('calcularTotales', () => {
  it('redondea el total en guaraníes al múltiplo de 50 hacia abajo', () => {
    const totales = calcularTotales({
      items: [{ precioUnitario: 107437, cantidad: 1, afectacionTributaria: 'GRAVADO', tasaIVA: 10 }],
    });

    expect(totales).toEqual({ totalOperacion: 107437, redondeo: 37, totalGeneral: 107400, totalGuaranies: 0 });
  });

  it('aplica descuentos por ítem y globales sobre el precio unitario', () => {
    const totales = calcularTotales({
      descuentoGlobalPorcentaje: 10,
      items: [
        { precioUnitario: 11000, cantidad: 2, afectacionTributaria: 'GRAVADO', tasaIVA: 10, descuentoParticular: 500 },
        {
          precioUnitario: 5250,
          cantidad: 3,
          afectacionTributaria: 'EXENTO',
          tasaIVA: 0,
          descuentoParticularPorcentaje: 12.5,
        },
      ],
    });

    // (11000 - 500 - 1100) * 2 = 18800; descuentos de 656.25 → 656 y 525 → (5250 - 656 - 525) * 3 = 12207
    expect(totales.totalOperacion).toBe(31007);
    expect(totales.totalGeneral).toBe(31000);
  });

  it('acepta cantidades decimales y redondea el ítem a guaraníes enteros', () => {
    const totales = calcularTotales({
      items: [{ precioUnitario: 12345, cantidad: '0.333', afectacionTributaria: 'GRAVADO', tasaIVA: 5 }],
    });

    // 12345 × 0.333 = 4110.885 → 4111
    expect(totales.totalOperacion).toBe(4111);
    expect(totales.totalGeneral).toBe(4100);
  });

  it('suma base gravada, liquidación y base exenta en el gravado parcial', () => {
    const totales = calcularTotales({
      items: [
        { precioUnitario: 100000, cantidad: 1, afectacionTributaria: 'GRAVADO_PARCIAL', tasaIVA: 10, propIVA: 30 },
      ],
    });

    // denominador 10300: base 29126, IVA 2913, exenta 67961
    expect(totales.totalOperacion).toBe(29126 + 2913 + 67961);
  });

  it('ignora ítems gravados sin una tasa válida, como el validador', () => {
    const totales = calcularTotales({
      items: [
        { precioUnitario: 1000, cantidad: 1, afectacionTributaria: 'GRAVADO', tasaIVA: 0 },
        { precioUnitario: 2000, cantidad: 1, afectacionTributaria: 'EXONERADO' },
      ],
    });

    expect(totales.totalOperacion).toBe(2000);
  });

  it('no redondea en moneda extranjera y convierte con el cambio global', () => {
    const totales = calcularTotales({
      monedaOperacion: 'USD',
      tipoCambio: '7300.5',
      comision: '1.005',
      items: [{ precioUnitario: '19.99', cantidad: 3, afectacionTributaria: 'GRAVADO', tasaIVA: 10 }],
    });

    expect(totales.redondeo).toBe(0);
    expect(totales.totalOperacion).toBe(59.97);
    expect(totales.totalGeneral).toBe(60.98);
    expect(totales.totalGuaranies).toBe(445184.49);
  });

  it('suma los guaraníes por ítem cuando no hay cambio global', () => {
    const totales = calcularTotales({
      monedaOperacion: 'USD',
      items: [
        { precioUnitario: 10, cantidad: 1, afectacionTributaria: 'GRAVADO', tasaIVA: 10, tipoCambio: 7000 },
        { precioUnitario: 5, cantidad: 2, afectacionTributaria: 'EXENTO', tipoCambio: 7100 },
      ],
    });

    expect(totales.totalGuaranies).toBe(70000 + 71000);
  });

  it('exige tipoCambio por ítem si la operación extranjera no tiene uno global', () => {
    expect(() =>
      calcularTotales({
        monedaOperacion: 'USD',
        items: [{ precioUnitario: 10, cantidad: 1, afectacionTributaria: 'GRAVADO', tasaIVA: 10 }],
      }),
    ).toThrow(TypeError);
  });
});
