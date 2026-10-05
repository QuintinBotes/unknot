# Local, unencrypted state with no locking.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
