/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Body, Controller, Post } from '@nestjs/common';
import { AppService } from './app.service';

interface paymentDTO {
  correlationId: string;
  amount: number;
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {
    this.teste();
  }

  async teste() {
    for (let i = 1; i <= 20; i++) {
      const paymentData = {
        data: { id: i, valor: 100 + i },
        resolve: (res) => console.log(`[${i}] Sucesso:`, res),
        reject: (err) => console.error(`[${i}] Falha:`, err.message),
      };
      const t = await this.appService.enqueuePayment(paymentData);
      console.log(t);
    }
  }

  @Post()
  async createPayment(@Body() paymentData: paymentDTO) {
    return this.appService.enqueuePayment(paymentData);
  }
}
