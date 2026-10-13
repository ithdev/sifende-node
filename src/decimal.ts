// Aritmética decimal exacta sobre BigInt: reproduce BigDecimal con RoundingMode.HALF_UP del backend.
export class Decimal {
  private constructor(
    readonly unidades: bigint,
    readonly escala: number,
  ) {}

  static readonly CERO: Decimal = new Decimal(0n, 0);

  static de(valor: number | string | Decimal): Decimal {
    if (valor instanceof Decimal) return valor;
    if (typeof valor === 'number' && !Number.isFinite(valor)) {
      throw new RangeError(`Número no finito: ${valor}`);
    }
    // toString usa notación exponencial fuera de [1e-7, 1e21); la expresión de abajo la acepta.
    const texto = typeof valor === 'number' ? valor.toString() : valor.trim();
    const coincidencia = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(texto);
    if (!coincidencia || (coincidencia[2] === '' && (coincidencia[3] ?? '') === '')) {
      throw new SyntaxError(`Decimal inválido: "${texto}"`);
    }
    const [, signo, entera = '', fraccion = '', exponente = '0'] = coincidencia;
    let unidades = BigInt(`${entera}${fraccion}` || '0');
    let escala = fraccion.length - Number(exponente);
    if (escala < 0) {
      unidades *= 10n ** BigInt(-escala);
      escala = 0;
    }
    return new Decimal(signo === '-' ? -unidades : unidades, escala);
  }

  sumar(otro: Decimal): Decimal {
    const [a, b, escala] = alinear(this, otro);
    return new Decimal(a + b, escala);
  }

  restar(otro: Decimal): Decimal {
    const [a, b, escala] = alinear(this, otro);
    return new Decimal(a - b, escala);
  }

  multiplicar(otro: Decimal): Decimal {
    return new Decimal(this.unidades * otro.unidades, this.escala + otro.escala);
  }

  dividir(divisor: Decimal, escala: number): Decimal {
    if (divisor.unidades === 0n) throw new RangeError('División por cero');
    const exponente = divisor.escala + escala - this.escala;
    let numerador = this.unidades;
    let denominador = divisor.unidades;
    if (exponente >= 0) numerador *= 10n ** BigInt(exponente);
    else denominador *= 10n ** BigInt(-exponente);
    return new Decimal(dividirMitadArriba(numerador, denominador), escala);
  }

  conEscala(escala: number): Decimal {
    if (escala >= this.escala) {
      return new Decimal(this.unidades * 10n ** BigInt(escala - this.escala), escala);
    }
    return new Decimal(dividirMitadArriba(this.unidades, 10n ** BigInt(this.escala - escala)), escala);
  }

  resto(divisor: Decimal): Decimal {
    const [a, b, escala] = alinear(this, divisor);
    return new Decimal(a % b, escala);
  }

  comparar(otro: Decimal): number {
    const [a, b] = alinear(this, otro);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  esCero(): boolean {
    return this.unidades === 0n;
  }

  abs(): Decimal {
    return this.unidades < 0n ? new Decimal(-this.unidades, this.escala) : this;
  }

  toString(): string {
    const negativo = this.unidades < 0n;
    const digitos = (negativo ? -this.unidades : this.unidades).toString().padStart(this.escala + 1, '0');
    const entera = digitos.slice(0, digitos.length - this.escala);
    const fraccion = this.escala > 0 ? `.${digitos.slice(digitos.length - this.escala)}` : '';
    return `${negativo ? '-' : ''}${entera}${fraccion}`;
  }

  aNumero(): number {
    return Number(this.toString());
  }
}

function alinear(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const escala = Math.max(a.escala, b.escala);
  return [a.unidades * 10n ** BigInt(escala - a.escala), b.unidades * 10n ** BigInt(escala - b.escala), escala];
}

function dividirMitadArriba(numerador: bigint, denominador: bigint): bigint {
  const cociente = numerador / denominador;
  const resto = numerador % denominador;
  if (resto === 0n) return cociente;
  const absResto = resto < 0n ? -resto : resto;
  const absDenominador = denominador < 0n ? -denominador : denominador;
  if (2n * absResto < absDenominador) return cociente;
  return numerador < 0n !== denominador < 0n ? cociente - 1n : cociente + 1n;
}
