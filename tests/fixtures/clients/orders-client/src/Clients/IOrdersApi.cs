using Refit;

namespace Shop.Clients
{
    [Headers("Accept: application/json")]
    public interface IOrdersApi
    {
        [Get("/v1/orders/{id}")]
        Task<OrderDto> GetAsync(string id);

        [Headers("X-Trace: on")]
        [Post("/v1/orders")]
        Task<OrderDto> CreateAsync([Body] OrderDto order);

        [Delete("/v1/orders/{id}/")]
        Task CancelAsync(string id);

        [Get("/v1/orders/{id}/history?limit=10")]
        Task<HistoryDto> HistoryAsync(string id);
    }

    public class OrderDto { public string Id { get; set; } }
    public class HistoryDto { public string Id { get; set; } }
}
