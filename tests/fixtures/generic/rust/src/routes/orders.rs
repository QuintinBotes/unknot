use crate::models::Order;

pub fn list_orders() -> Vec<Order> {
    Vec::new()
}

pub fn classify(total: i64, express: bool) -> &'static str {
    match total {
        0 => "empty",
        1..=100 => "small",
        _ if express && total > 1000 => "rush",
        _ => "large",
    }
}
