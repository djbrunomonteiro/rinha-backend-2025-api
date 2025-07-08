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

  listenHealth() {
    const endpoints = [
      { port: 8001, subject: this.defaultHealth$ },
      { port: 8002, subject: this.fallbackHealth$ },
    ];

    interval(6000)
      .pipe(
        mergeMap(() => from(endpoints)),
        mergeMap(({ port, subject }) => {
          const url = `http://localhost:${port}/payments/service-health`;
          return this.rxCheckHealth(url).pipe(
            mergeMap((status) => {
              console.log({port, status})
              subject.next(status);
              return of(null);
            }),
          );
        }),
      )
      .subscribe();
  }

  private rxCheckHealth(url: string) {
    return from(firstValueFrom(this.http.get(url))).pipe(
      mergeMap((res) => {
        const data = res.data;
        return of({
          healthy: !data.failing,
          minResponseTime: data.minResponseTime ?? Infinity,
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

  private  processPayment(paymentRequest: PaymentRequest) {
    const process$ = combineLatest([
      this.defaultHealth$.pipe(take(1)),
      this.fallbackHealth$.pipe(take(1)),
      this.defaultBlocked$.pipe(take(1)),
    ]).pipe(
      switchMap(([defaultHealth, fallbackHealth, isDefaultBlocked]) => {
        const shouldUseDefault = defaultHealth.healthy && !isDefaultBlocked;
 
        if (shouldUseDefault) {
          return this.tryProcess(paymentRequest.payment, 'default', 'http://localhost:8001/').pipe(
            timeout(3000),
            catchError(() => {
              this.triggerDefaultCooldown();
              if (fallbackHealth.healthy) {
                return this.tryProcess(
                  paymentRequest.payment,
                  'fallback',
                  'http://localhost:8002/',
                ).pipe(timeout(3000));
              }
              return of('ambos falharam');
            }),
          );
        }

        if (fallbackHealth.healthy) {
          return this.tryProcess(paymentRequest.payment, 'fallback', 'http://localhost:8002/').pipe(
            timeout(3000),
          );
        }

        throw new Error('Deu ruim nenhum disponivel');
      }),
      tap({
        next: (result) => paymentRequest.resolve(result),
        error: (err) => paymentRequest.reject(err),
      })
    );

    return process$
  }

  private tryProcess(payment: paymentDTO, origin: string, baseUrl: string, ) {
    const url = `${baseUrl}payments`;
    console.log(payment)
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
        requested_at TEXT NOT NULL,
        origin TEXT NOT NULL
      );
    `);
  }

  add(payment: paymentDTO, origin: string){
    try {
      this.db.prepare(`
        INSERT INTO payments (correlation_id, amount, requested_at, origin)
        VALUES (?, ?, ?, ?)
      `).run(payment.correlationId, payment.amount, payment.requestedAt, origin);
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
