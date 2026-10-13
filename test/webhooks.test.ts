import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirmaWebhookInvalidaError } from '../src/errores.js';
import { firmarWebhook, verificarWebhook } from '../src/webhooks.js';

const secreto = 'whsec_prueba';
const eventId = 'd44f9f47-380f-4f51-b5c9-4fa335711e18';
const deliveryId = '7b0e3c52-2f7e-4a8e-9a55-1f0f3c4d5e6a';
const timestamp = 1_786_633_200;
const ahora = new Date(timestamp * 1000);
const cuerpo = JSON.stringify({
  id: eventId,
  tipo: 'documento.aprobado',
  version: '1',
  ocurridoEn: '2026-08-13T15:00:00Z',
  contribuyenteId: 42,
  ambiente: 'PROD',
  data: { documentoId: 'x', cdc: '0180', estado: 'APROBADO', loteId: 815, protocoloAutorizacion: '1', resultados: [] },
});

// Misma receta que la documentación (y que WebhookSigner en el worker).
const firmaEsperada = `v1=${createHmac('sha256', secreto).update(`${eventId}.${deliveryId}.${timestamp}.${cuerpo}`).digest('base64')}`;

function headers(firma = firmaEsperada) {
  return {
    'X-Sifende-Event-Id': eventId,
    'X-Sifende-Delivery-Id': deliveryId,
    'X-Sifende-Timestamp': String(timestamp),
    'X-Sifende-Signature': firma,
  };
}

describe('verificarWebhook', () => {
  it('acepta la firma calculada como en el worker y devuelve el evento', async () => {
    const evento = await verificarWebhook({ cuerpo, headers: headers(), secreto, ahora });

    expect(evento.tipo).toBe('documento.aprobado');
    if (evento.tipo !== 'documento.aprobado') throw new Error('tipo inesperado');
    expect(evento.data.cdc).toBe('0180');
  });

  it('acepta el cuerpo como bytes y los headers como Headers', async () => {
    const evento = await verificarWebhook({
      cuerpo: Buffer.from(cuerpo),
      headers: new Headers(headers()),
      secreto,
      ahora,
    });

    expect(evento.id).toBe(eventId);
  });

  it('acepta el secreto anterior durante una rotación', async () => {
    await expect(
      verificarWebhook({ cuerpo, headers: headers(), secreto: ['whsec_nuevo', secreto], ahora }),
    ).resolves.toBeDefined();
  });

  it('rechaza un cuerpo modificado', async () => {
    await expect(
      verificarWebhook({ cuerpo: cuerpo.replace('APROBADO', 'RECHAZADO'), headers: headers(), secreto, ahora }),
    ).rejects.toBeInstanceOf(FirmaWebhookInvalidaError);
  });

  it('rechaza otro secreto', async () => {
    await expect(verificarWebhook({ cuerpo, headers: headers(), secreto: 'whsec_otro', ahora })).rejects.toBeInstanceOf(
      FirmaWebhookInvalidaError,
    );
  });

  it('rechaza un timestamp fuera de la tolerancia', async () => {
    await expect(
      verificarWebhook({ cuerpo, headers: headers(), secreto, ahora: new Date((timestamp + 301) * 1000) }),
    ).rejects.toThrow(/tolerancia/);
  });

  it('rechaza headers faltantes', async () => {
    await expect(
      verificarWebhook({ cuerpo, headers: { 'X-Sifende-Signature': firmaEsperada }, secreto, ahora }),
    ).rejects.toThrow(/Faltan/);
  });
});

describe('firmarWebhook', () => {
  it('produce la misma firma que el worker', async () => {
    await expect(firmarWebhook({ secreto, eventId, deliveryId, timestamp, cuerpo })).resolves.toBe(firmaEsperada);
  });
});
