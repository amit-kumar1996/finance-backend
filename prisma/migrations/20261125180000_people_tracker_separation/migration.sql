ALTER TABLE `persons`
  MODIFY `receivable_account_id` VARCHAR(30) NULL,
  MODIFY `payable_account_id` VARCHAR(30) NULL;

CREATE TABLE `person_transactions` (
  `id` VARCHAR(30) NOT NULL,
  `user_id` VARCHAR(30) NOT NULL,
  `person_id` VARCHAR(30) NOT NULL,
  `movement` ENUM('GIVE', 'RECEIVE', 'BORROW', 'REPAY') NOT NULL,
  `payment_method` ENUM('CASH', 'UPI', 'CARD') NOT NULL,
  `effective_date` DATE NOT NULL,
  `amount` DECIMAL(18, 2) NOT NULL,
  `note` VARCHAR(250) NULL,
  `idempotency_key` VARCHAR(128) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `person_tx_user_person_date_created_idx` (`user_id`, `person_id`, `effective_date`, `created_at`),
  UNIQUE INDEX `person_transactions_user_id_idempotency_key_key` (`user_id`, `idempotency_key`),
  PRIMARY KEY (`id`),
  CONSTRAINT `person_transactions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `person_transactions_person_id_fkey` FOREIGN KEY (`person_id`) REFERENCES `persons` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
