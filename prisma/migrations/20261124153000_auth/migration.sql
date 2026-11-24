-- AlterTable
ALTER TABLE `users` ADD COLUMN `singleton` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `webauthn_credentials` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `credential_id` TEXT NOT NULL,
    `credential_id_hash` CHAR(64) NOT NULL,
    `public_key` BLOB NOT NULL,
    `counter` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `transports` JSON NULL,
    `device_name` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NULL,

    UNIQUE INDEX `webauthn_credentials_credential_id_hash_key`(`credential_id_hash`),
    INDEX `webauthn_credentials_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_challenges` (
    `id` VARCHAR(30) NOT NULL,
    `challenge` VARCHAR(200) NOT NULL,
    `purpose` ENUM('REGISTRATION', 'AUTHENTICATION') NOT NULL,
    `user_id` VARCHAR(30) NULL,
    `user_handle` VARCHAR(30) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `auth_challenges_challenge_key`(`challenge`),
    INDEX `auth_challenges_purpose_expires_at_idx`(`purpose`, `expires_at`),
    INDEX `auth_challenges_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_sessions` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `recovery_only` BOOLEAN NOT NULL DEFAULT false,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_used_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,

    UNIQUE INDEX `auth_sessions_token_hash_key`(`token_hash`),
    INDEX `auth_sessions_user_id_revoked_at_expires_at_idx`(`user_id`, `revoked_at`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recovery_codes` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `used_at` DATETIME(3) NULL,

    UNIQUE INDEX `recovery_codes_code_hash_key`(`code_hash`),
    INDEX `recovery_codes_user_id_used_at_idx`(`user_id`, `used_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `users_singleton_key` ON `users`(`singleton`);

-- AddForeignKey
ALTER TABLE `webauthn_credentials` ADD CONSTRAINT `webauthn_credentials_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_challenges` ADD CONSTRAINT `auth_challenges_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recovery_codes` ADD CONSTRAINT `recovery_codes_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
