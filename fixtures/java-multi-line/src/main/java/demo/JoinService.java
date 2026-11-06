package demo;

import java.util.Map;
import java.util.List;

/** 接口方法签名跨多行 + 泛型返回：早期逐行正则会整段漏掉 */
public interface JoinService {
    Map<String, Object> listApplications(
            String status,
            String platform,
            String country,
            int page,
            int size
    );

    List<String> simple(int page);
}
