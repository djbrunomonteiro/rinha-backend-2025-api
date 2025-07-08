/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { AppService } from './app.service';

export interface paymentDTO {
  correlationId: string;
  amount: number;
  requestedAt?: string;
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('payments')
  async createPayment(@Body() paymentData: paymentDTO) {
    return this.appService.enqueuePayment(paymentData);
  }

  @Post('purge-payments')
  @HttpCode(200)
  async purgePayment() {
    return await this.appService.purgePayment();
  }

  @Get('payments-summary')
  getSummary(@Query('from') from: string, @Query('to') to: string) {
    if (!from || !to) {
      throw new BadRequestException(
        'Query params "from" and "to" are required',
      );
    }
    return this.appService.getPaymentsSummary(from, to);
  }
}
