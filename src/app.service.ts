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
  throwError,
  timeout,
  timer,
} from 'rxjs';

interface PaymentRequest {
  data: any; // dados do pagamento
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

@Injectable()
export class AppService {
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

  enqueuePayment(data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.paymentQueue$.next({ data, resolve, reject });
    });
  }

  private  processPayment(payment: PaymentRequest) {
    const process$ = combineLatest([
      this.defaultHealth$.pipe(take(1)),
      this.fallbackHealth$.pipe(take(1)),
      this.defaultBlocked$.pipe(take(1)),
    ]).pipe(
      switchMap(([defaultHealth, fallbackHealth, isDefaultBlocked]) => {
        const shouldUseDefault = defaultHealth.healthy && !isDefaultBlocked;
        return of({defaultHealth, fallbackHealth})

        if (shouldUseDefault) {
          return this.tryProcess(payment.data, 'http://localhost:8001/').pipe(
            timeout(3000),
            catchError(() => {
              this.triggerDefaultCooldown();
              if (fallbackHealth.healthy) {
                return this.tryProcess(
                  payment.data,
                  'http://localhost:8002/',
                ).pipe(timeout(3000));
              }
              throw new Error('ambos falharam');
            }),
          );
        }

        if (fallbackHealth.healthy) {
          return this.tryProcess(payment.data, 'http://localhost:8002/').pipe(
            timeout(3000),
          );
        }

        throw new Error('Deu ruim nenhum disponivel');
      }),
      tap({
        next: (result) => payment.resolve(result),
        error: (err) => payment.reject(err),
      })
    );

    return process$
  }

  private tryProcess(data: any, baseUrl: string) {
    const url = `${baseUrl}process-payment`;
    return this.http.post(url, data).pipe(
      timeout(5000),
      map(({ data }) => data),
      catchError((err) => {
        return throwError(
          () =>
            new Error(
              `Erro ao processar pagamento em ${baseUrl}: ${err.message}`,
            ),
        );
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
}
