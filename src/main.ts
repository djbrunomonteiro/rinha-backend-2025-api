import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 7171);

  console.log('Default URL:', process.env.PAYMENT_PROCESSOR_URL_DEFAULT);
  console.log('Fallback URL:', process.env.PAYMENT_PROCESSOR_URL_FALLBACK);
}
bootstrap();
