import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { rlsContext } from '../rls-context';
import { RequestWithUser } from '../guards/jwt-auth.guard';

@Injectable()
export class RlsInterceptor implements NestInterceptor {
  constructor(private readonly dataSource: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    // Check if the user has a tenantId (i.e. is a Client)
    const tenantId = user?.tenantId;

    if (!tenantId) {
      // Admins and public routes run without RLS transaction wrapping
      return next.handle();
    }

    // Wrap the request execution inside a transaction block to enforce RLS SET LOCAL
    return from(
      this.dataSource.transaction(async (transactionalEntityManager) => {
        // Enforce Row-Level Security session setting
        await transactionalEntityManager.query(
          `SET LOCAL app.current_tenant_id = $1`,
          [tenantId],
        );

        // Run request handler in the context of this transaction
        const result: unknown = await rlsContext.run(
          {
            tenantId,
            entityManager: transactionalEntityManager,
            isAdmin: false,
          },
          () => lastValueFrom<unknown>(next.handle()),
        );

        return result;
      }),
    );
  }
}
