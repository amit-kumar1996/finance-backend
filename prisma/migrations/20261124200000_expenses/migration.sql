-- AlterTable
ALTER TABLE `users` ADD COLUMN `default_expense_account_id` VARCHAR(30) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `users_default_expense_account_id_key` ON `users`(`default_expense_account_id`);

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_default_expense_account_id_fkey` FOREIGN KEY (`default_expense_account_id`) REFERENCES `financial_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
