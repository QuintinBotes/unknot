pub trait Priced {
    fn price(&self) -> i64;
}

pub struct Order {
    pub id: i64,
}

impl Priced for Order {
    fn price(&self) -> i64 {
        self.id * 2
    }
}
