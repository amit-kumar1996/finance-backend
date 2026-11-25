export type PersonMovement = "GIVE" | "RECEIVE" | "BORROW" | "REPAY";
export type PersonPaymentMethod = "CASH" | "UPI" | "CARD";

export interface PersonSummary {
  id: string;
  name: string;
  notes: string | null;
  createdAt: Date;
  givenTotal: string;
  receivedTotal: string;
  borrowedTotal: string;
  repaidTotal: string;
  receivableBalance: string;
  payableBalance: string;
  netBalance: string;
  type: "Given" | "Borrowed" | "Both" | "—";
  givenOrBorrowed: string;
  receivedOrRepaid: string;
}

export interface PersonRecord extends PersonSummary {
  archivedAt: Date | null;
}

export interface PersonStatementRow {
  id: string;
  effectiveDate: string;
  description: string;
  movement: PersonMovement;
  paymentMethod: PersonPaymentMethod;
  amount: string;
  netEffect: "INCREASED" | "DECREASED";
  runningNetBalance: string;
  reversalOfId: null;
}

export interface PersonStatement {
  person: PersonSummary;
  transactions: PersonStatementRow[];
}

export interface PersonMutationInput {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  personId?: string;
  name: string;
  notes: string | null;
}

export interface IdempotentPersonResource {
  resourceId: string;
  requestHash: string;
}

export interface PersonMovementInput {
  userId: string;
  personId: string;
  idempotencyKey: string;
  effectiveDate: string;
  movement: PersonMovement;
  paymentMethod: PersonPaymentMethod;
  amount: string;
  note?: string;
}

export interface PersonMovementRecord {
  id: string;
  requestHash: string;
}

export interface PersonMovementResult {
  person: PersonSummary;
  transaction: { id: string };
}

export interface PeopleRepository {
  listPeople(userId: string): Promise<PersonSummary[]>;
  getPerson(
    userId: string,
    personId: string,
    includeArchived?: boolean,
  ): Promise<PersonRecord | null>;
  getStatement(userId: string, personId: string): Promise<PersonStatement | null>;
  findIdempotencyRecord(
    userId: string,
    key: string,
  ): Promise<IdempotentPersonResource | null>;
  findMovementByIdempotency(
    userId: string,
    key: string,
  ): Promise<PersonMovementRecord | null>;
  createMovement(input: PersonMovementInput & { requestHash: string }): Promise<string>;
  createPerson(input: PersonMutationInput): Promise<string>;
  updatePerson(input: PersonMutationInput): Promise<string>;
  archivePerson(input: Omit<PersonMutationInput, "name" | "notes">): Promise<string>;
}
