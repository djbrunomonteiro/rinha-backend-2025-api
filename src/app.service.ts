/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import {
  BehaviorSubject,
  catchError,
  combineLatest,
  delay,
  EMPTY,
  filter,
  firstValueFrom,
  from,
  interval,
  map,
  mergeMap,
  of,
  race,
  Subject,
  switchMap,
  take,
  tap,
  timeout,
  timer,
} from 'rxjs';
import { paymentDTO } from './app.controller';
import Database from 'better-sqlite3';
import * as fs from 'fs';

interface PaymentRequest {
  payment: paymentDTO; 
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

@Injectable()
export class AppService {
  defaultUrl = process.env.PAYMENT_PROCESSOR_URL_DEFAULT || 'http://payment-processor-default:8080';;
  fallbackUrl = process.env.PAYMENT_PROCESSOR_URL_FALLBACK || 'http://payment-processor-fallback:8080';

  private db: Database;

  private paymentQueue$ = new Subject<PaymentRequest>();
  private defaultHealth$ = new BehaviorSubject<any>({
    healthy: true,
    minResponseTime: 1000,
  });
  private fallbackHealth$ = new BehaviorSubject<any>({
    healthy: true,
    minResponseTime: 1000,
  });
  private defaultBlocked$ = new BehaviorSubject<boolean>(false);

  constructor(private http: HttpService) {
    this.initDB();
  

    this.listenHealth();
    this.listenEnqueuePayment();
  }

  async purgePayment(){
    this.db.exec(`DELETE FROM payments;`);
    const response = await firstValueFrom(
      this.http.post(`${this.defaultUrl}/admin/purge-payments`, {}, {
        headers: {
          'X-Rinha-Token': '123',
        },
      }),
    );
    return response.data;
  }

  listenHealth() {
    const endpoints = [
      { path: this.defaultUrl, subject: this.defaultHealth$ },
      { path: this.fallbackUrl, subject: this.fallbackHealth$ },
    ];

    interval(5100)
      .pipe(
        mergeMap(() => from(endpoints)),
        mergeMap(({ path, subject }) => {
          const url = `${path}/payments/service-health`;
          return this.rxCheckHealth(url).pipe(
            mergeMap((status) => {
              subject.next(status);
              return of(null);
            }),
            catchError(err => of(err))
          );
        }),
      )
      .subscribe();
  }

  private rxCheckHealth(url: string) {
    return this.http.get(url, {
      validateStatus: () => true
    }).pipe(
      mergeMap((res) => {
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
          return of({
            healthy: false,
            minResponseTime: Infinity,
          }).pipe(delay(retryAfter * 1000));
        }
  
        if (res.status >= 200 && res.status < 300) {
          const data = res.data;
          return of({
            healthy: !data.failing,
            minResponseTime: data.minResponseTime ?? Infinity,
          });
        }
  
        return of({
          healthy: false,
          minResponseTime: Infinity,
        });
      }),
      catchError((err) => {
        console.error(`[HEALTH] ${url} erro de conexão:`, err.message);
        return of({
          healthy: false,
          minResponseTime: Infinity,
        });
      }),
    );
  }
  
  listenEnqueuePayment() {
    this.paymentQueue$
      .pipe(mergeMap((payment) => this.processPayment(payment), 5))
      .subscribe();
  }

  enqueuePayment(payment: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.paymentQueue$.next({ payment, resolve, reject });
    });
  }

  private processPayment(paymentRequest: PaymentRequest) {
    const process$ = combineLatest([
      this.defaultHealth$.pipe(take(1)),
      this.fallbackHealth$.pipe(take(1)),
      this.defaultBlocked$.pipe(take(1)),
    ]).pipe(
      switchMap(([defaultHealth, fallbackHealth, isDefaultBlocked]) => {
        const shouldUseDefault = defaultHealth.healthy && !isDefaultBlocked;
  
        if (shouldUseDefault) {
          return this.tryProcess(paymentRequest.payment, 'default', this.defaultUrl).pipe(
            timeout(3000),
            catchError(() => {
              this.triggerDefaultCooldown();
              if (fallbackHealth.healthy) {
                return this.tryProcess(paymentRequest.payment, 'fallback', this.fallbackUrl).pipe(
                  timeout(3000),
                  catchError((err) => {
                    return of(`falha no fallback: ${err.message || err}`);
                  })
                );
              }
              return of('falha em ambos (default e fallback indisponível)');
            })
          );
        }
  
        if (fallbackHealth.healthy) {
          return this.tryProcess(paymentRequest.payment, 'fallback', this.fallbackUrl).pipe(
            timeout(3000),
            catchError((err) => {
              return of(`falha no fallback direto: ${err.message || err}`);
            })
          );
        }
  
        // Ao invés de lançar erro direto, transforme em Observable
        return of('nenhuma rota disponível (default e fallback indisponíveis)');
      }),
      tap({
        next: (result) => paymentRequest.resolve(result),
        error: (err) => paymentRequest.reject(err),
      }),
      // Segurança extra: qualquer erro escapa aqui
      catchError((err) => {
        paymentRequest.reject(err);
        return EMPTY; // ou `of(null)` se quiser continuar a stream
      })
    );
  
    return process$;
  }
  

  private tryProcess(payment: paymentDTO, origin: string, baseUrl: string, ) {
    const url = `${baseUrl}/payments`;
    return this.http.post(url, payment).pipe(
      timeout(5000),
      map(({ data }) => {
        this.add(payment, origin)
        return data
      }),
      catchError((err) => {
        return of(err?.message)
      }),
    );
  }

  private triggerDefaultCooldown() {
    if (this.defaultBlocked$.getValue()) return;

    this.defaultBlocked$.next(true);
    race(
      timer(5000),
      this.defaultHealth$.pipe(
        filter(({ healthy }) => healthy),
        take(1),
      ),
    ).subscribe(() => {
      this.defaultBlocked$.next(false);
    });
  }

  // private paymentSummary(from: string, to: string){

  // }

  initDB(){
    const path = './data/payments.db';
    if (!fs.existsSync('./data')) fs.mkdirSync('./data');
    
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        correlation_id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        requested_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        origin TEXT NOT NULL
      );
    `);
  }

  add(payment: paymentDTO, origin: string){
    try {
      this.db.prepare(`
        INSERT INTO payments (correlation_id, amount, origin)
        VALUES (?, ?, ?)
      `).run(payment.correlationId, payment.amount, origin);
      return true;
    } catch (e) {
      console.log(e)
      return false;
    }
  }

  getPaymentsSummary(from: string, to: string) {
    const stmt = this.db.prepare(`
      SELECT origin,
             COUNT(*) as totalRequests,
             SUM(amount) as totalAmount
        FROM payments
       WHERE requested_at >= ? AND requested_at <= ?
       GROUP BY origin;
    `);
  
    const rows = stmt.all(from, to);
  
    const result = {
      default: { totalRequests: 0, totalAmount: 0 },
      fallback: { totalRequests: 0, totalAmount: 0 },
    };
  
    for (const row of rows) {
      const key = row.origin === 'default' ? 'default' : 'fallback';
      result[key] = {
        totalRequests: Number(row.totalRequests),
        totalAmount: Number(row.totalAmount),
      };
    }
  
    return result;
  }

  onModuleDestroy() {
    this.db.close();
  }
}
